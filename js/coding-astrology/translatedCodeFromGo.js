const crypto = require('crypto');
const { ECDSA } = require('crypto');
const { readFileSync } = require('fs');
const { createServer } = require('http');
const { Octokit } = require('@octokit/rest');
const { parse } = require('jsonschema');
const { OrderedMap } = require('immutable');

let tools = [];

function init() {
    const listProperties = new OrderedMap()
        .set('repository_owner', {
            type: 'string',
            description: 'The owner of the repository'
        })
        .set('repository_name', {
            type: 'string',
            description: 'The type of the repository'
        });

    const createProperties = new OrderedMap()
        .set('repository_owner', {
            type: 'string',
            description: 'The owner of the repository'
        })
        .set('repository_name', {
            type: 'string',
            description: 'The name of the repository'
        })
        .set('issue_title', {
            type: 'string',
            description: 'The title of the issue being created'
        })
        .set('issue_body', {
            type: 'string',
            description: 'The content of the issue being created'
        });

    tools = [
        {
            type: 'function',
            function: {
                name: 'list_issues',
                description: 'Fetch a list of issues from github.com for a given repository. Users may specify the repository owner and the repository name separately, or they may specify it in the form {repository_owner}/{repository_name}, or in the form github.com/{repository_owner}/{repository_name}.',
                parameters: {
                    type: 'object',
                    properties: listProperties.toJS(),
                    required: ['repository_owner', 'repository_name']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_issue_dialog',
                description: 'Creates a confirmation dialog in which the user can interact with in order to create an issue on a github.com repository. Only one dialog should be created for each issue/repository combination. Users may specify the repository owner and the repository name separately, or they may specify it in the form {repository_owner}/{repository_name}, or in the form github.com/{repository_owner}/{repository_name}.',
                parameters: {
                    type: 'object',
                    properties: createProperties.toJS(),
                    required: ['repository_owner', 'repository_name', 'issue_title', 'issue_body']
                }
            }
        }
    ];
}

class Service {
    constructor(pubKey) {
        this.pubKey = pubKey;
    }

    async chatCompletion(req, res) {
        const sig = req.headers['github-public-key-signature'];
        const body = await getRequestBody(req);

        const isValid = await validPayload(body, sig, this.pubKey);
        if (!isValid) {
            res.statusCode = 401;
            res.end('invalid payload signature');
            return;
        }

        const apiToken = req.headers['x-github-token'];
        const integrationID = req.headers['copilot-integration-id'];

        let chatRequest;
        try {
            chatRequest = JSON.parse(body);
        } catch (err) {
            res.statusCode = 400;
            res.end('failed to unmarshal request');
            return;
        }

        try {
            await generateCompletion(req.context, integrationID, apiToken, chatRequest, new SSEWriter(res));
        } catch (err) {
            res.statusCode = 500;
            res.end('failed to execute agent');
        }
    }
}

async function generateCompletion(ctx, integrationID, apiToken, req, writer) {
    for (const conf of req.messages[req.messages.length - 1].confirmations) {
        if (conf.state !== 'accepted') continue;

        await createIssue(ctx, apiToken, conf.confirmation.owner, conf.confirmation.repo, conf.confirmation.title, conf.confirmation.body);
        writer.writeData({
            choices: [{
                index: 0,
                delta: {
                    role: 'assistant',
                    content: `Created issue ${conf.confirmation.title} on repository ${conf.confirmation.owner}/${conf.confirmation.repo}`
                }
            }]
        });
        return;
    }

    let messages = [...req.messages];
    let confs = [];

    for (let i = 0; i < 5; i++) {
        const chatReq = {
            model: 'gpt-3.5-turbo',
            messages
        };

        if (i < 4) chatReq.tools = tools;

        const res = await copilotChatCompletions(ctx, integrationID, apiToken, chatReq);
        const functionCall = getFunctionCall(res);

        if (!functionCall) {
            writer.writeData({
                choices: res.choices.map(choice => ({
                    index: choice.index,
                    delta: {
                        role: choice.message.role,
                        content: choice.message.content
                    }
                }))
            });
            writer.writeDone();
            break;
        }

        switch (functionCall.name) {
            case 'list_issues':
                const listArgs = JSON.parse(functionCall.arguments);
                const msg = await listIssues(ctx, apiToken, listArgs.repository_owner, listArgs.repository_name);
                messages.push(msg);
                break;
            case 'create_issue_dialog':
                const createArgs = JSON.parse(functionCall.arguments);
                const [conf, msg] = createIssueConfirmation(createArgs.repository_owner, createArgs.repository_name, createArgs.issue_title, createArgs.issue_body);

                if (!confs.some(existingConf => JSON.stringify(existingConf) === JSON.stringify(conf.confirmation))) {
                    confs.push(conf.confirmation);
                    writer.writeEvent('copilot_confirmation');
                    writer.writeData(conf);
                    messages.push(msg);
                }
                break;
            default:
                throw new Error(`unknown function call: ${functionCall.name}`);
        }
    }
}

async function listIssues(ctx, apiToken, owner, repo) {
    const octokit = new Octokit({ auth: apiToken });
    const { data: issues } = await octokit.issues.listForRepo({ owner, repo });

    return {
        role: 'system',
        content: `The issues for the repository ${owner}/${repo} are: ${JSON.stringify(issues)}`
    };
}

function createIssueConfirmation(owner, repo, title, body) {
    return [{
        type: 'action',
        title: 'Create Issue',
        message: `Are you sure you want to create an issue in repository ${owner}/${repo} with the title "${title}" and the content "${body}"`,
        confirmation: { owner, repo, title, body }
    }, {
        role: 'system',
        content: `Issue dialog created: {"issue_title": "${title}", "issue_body": "${body}", "repository_owner": "${owner}", "repository_name": "${repo}"}`
    }];
}

async function createIssue(ctx, apiToken, owner, repo, title, body) {
    const octokit = new Octokit({ auth: apiToken });
    await octokit.issues.create({ owner, repo, title, body });
}

async function validPayload(data, sig, publicKey) {
    const asnSig = Buffer.from(sig, 'base64');
    const parsedSig = asn1.decode(asnSig, asn1Signature);
    const digest = crypto.createHash('sha256').update(data).digest();
    return ECDSA.verify(digest, parsedSig, publicKey);
}

function getFunctionCall(res) {
    // Check if there are choices and tool calls
    if (res.choices.length === 0 || res.choices[0].message.toolCalls.length === 0) {
        return null;
    }
    // Return the first function call
    return res.choices[0].message.toolCalls[0].function;
}

function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

class SSEWriter {
    constructor(res) {
        this.res = res;
    }

    writeData(data) {
        this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    writeEvent(event) {
        this.res.write(`event: ${event}\n`);
    }

    writeDone() {
        this.res.end();
    }
}

init();