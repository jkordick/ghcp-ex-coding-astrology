import { Octokit } from "@octokit/core";
import express from "express";
import { Readable } from "node:stream";



async function get_last_five_commit_messages(octokit, owner, repo) {
  const commits = await octokit.request("GET /repos/{owner}/{repo}/commits", {
    owner,
    repo,
  });

  const commitMessages = commits.data.map((commit) => commit.commit.message);
  return commitMessages.slice(-5);
}

async function get_last_commit_message(octokit, repo_owner, repo_name) {
  const commits = await octokit.request("GET /repos/{owner}/{repo}/commits", {
    owner,
    repo,
  });

  if (commits.data.length === 0) {
    return "I'm sorry the stars are not aligned to answer that question.";
  }

  return commits.data[0].commit.message;
}


async function list_issues(octokit, repo_owner, repo_name) {
  const { data: issues } = await octokit.issues.listForRepo({ repo_owner, repo_name });

  return {
      role: 'system',
      content: `The issues for the repository ${repo_owner}/${repo_name} are: ${JSON.stringify(issues)}`
  };
}

function create_issue_confirmation(repo_owner, repo_name, issue_title, issue_body) {
  return [{
      type: 'action',
      title: 'Create Issue',
      message: `Are you sure you want to create an issue in repository ${repo_owner}/${repo_name} with the title "${issue_title}" and the content "${issue_body}"`,
      confirmation: { repo_owner, repo_name, issue_title, issue_body }
  }, {
      role: 'system',
      content: `Issue dialog created: {"issue_title": "${issue_title}", "issue_body": "${issue_body}", "repository_owner": "${repo_owner}", "repository_name": "${repo_name}"}`
  }];
}

async function create_issue(octokit, repo_owner, repo_name, issue_title, issue_body) {
  await octokit.issues.create({ repo_owner, repo_name, issue_title, issue_body });
}

let tools = [];

tools = [
  {
    type: 'function',
    function: {
      name: 'get_last_five_commit_messages',
      description: 'Get the last five commit messages for a repository',
      parameters: [
        {
          name: 'repo_owner',
          type: 'string',
          description: 'The owner of the repository'
        },
        {
          name: 'repo_name',
          type: 'string',
          description: 'The name of the repository'
        }
      ]
    }
  },
  {
    type: "function",
    function: {
      name: "get_last_commit_message",
      description: "Get the last commit message for a repository",
      parameters: [
        {
          name: 'repo_owner',
          type: 'string',
          description: 'The owner of the repository'
        },
        {
          name: 'repo_name',
          type: 'string',
          description: 'The name of the repository'
        }
      ]
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_issues',
      description: 'Fetch a list of issues from github.com for a given repository. Users may specify the repository owner and the repository name separately, or they may specify it in the form {repository_owner}/{repository_name}, or in the form github.com/{repository_owner}/{repository_name}.',
      parameters: [
        {
          name: 'repo_owner',
          type: 'string',
          description: 'The owner of the repository'
        },
        {
          name: 'repo_name',
          type: 'string',
          description: 'The name of the repository'
        }
      ]
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_issue_dialog',
      description: 'Creates a confirmation dialog in which the user can interact with in order to create an issue on a github.com repository. Only one dialog should be created for each issue/repository combination. Users may specify the repository owner and the repository name separately, or they may specify it in the form {repository_owner}/{repository_name}, or in the form github.com/{repository_owner}/{repository_name}.',
      parameters: [
        {
          name: 'repo_owner',
          type: 'string',
          description: 'The owner of the repository'
        },
        {
          name: 'repo_name',
          type: 'string',
          description: 'The name of the repository'
        },
        {
          name: 'issue_title',
          type: 'string',
          description: 'The title of the issue being created'
        },
        {
          name: 'issue_body',
          type: 'string',
          description: 'The content of the issue being created'
        }
      ]
    }
  }
]

let available_tools = {
  "get_last_five_commit_messages": get_last_five_commit_messages,
  "get_last_commit_message": get_last_commit_message,
  "list_issues": list_issues,
  "create_issue": create_issue
}

const app = express()

app.get("/", express.json(), async (req, res) => {
  res.send("Hello Copilot!");
});

app.post("/agent", express.json(), async (req, res) => {
  // Identify the user, using the GitHub API token provided in the request headers.
  const tokenForUser = req.get("X-GitHub-Token");
  const octokit = new Octokit({ auth: tokenForUser });
  const user = await octokit.request("GET /user");
  console.log("User:", user.data.login);

  // Parse the request payload and log it.
  const payload = req.body;
  console.log("Payload:", payload);

  const messages = payload.messages;
  messages.unshift({
    role: "system",
    content: "You are coding assistant, talking like an astrologer. " +
      "Start every response with the user's name, which is @${user.data.login}. " +
      "If you do not know an answer or do not have the proper access rights, answer: 'I'm sorry the "
      + "stars are not aligned to answer that question.'",
  });


  // Use Copilot's LLM to generate a response to the user's messages, with
  // our extra system messages attached.
  const copilotLLMResponse = await fetch(
    "https://api.githubcopilot.com/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenForUser}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages,
        stream: true
      }),
    }
  );

  // Stream the response straight back to the user.
  Readable.from(copilotLLMResponse.body).pipe(res);
})

app.get("/callback", (req, res) => {
  res.send("You may close this tab and return to GitHub.com "
    + "(where you should refresh the page and start a fresh chat). "
    + "If you're using VS Code or Visual Studio, return there.");
});

const port = Number(process.env.PORT || '3000')
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
});