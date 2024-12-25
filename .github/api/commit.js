import { request } from "@octokit/request";
import { readFileSync } from "fs";
import { join } from "path";

(async () => {
  const filesJson = process.argv.slice(2);
  const branchName = process.env.GITHUB_BRANCH_NAME;
  const commitMessage = process.env.GITHUB_COMMIT_MESSAGE;
  const githubToken = process.env.GITHUB_TOKEN;
  const repoOwner = process.env.GITHUB_REPOSITORY.split("/")[0];
  const repoName = process.env.GITHUB_REPOSITORY.split("/")[1];
  const graphqlEndpoint = "https://api.github.com/graphql";

  try {
    // Get branch details
    const branchQuery = `
      query ($owner: String!, $name: String!, $branchName: String!) {
        repository(owner: $owner, name: $name) {
          ref(qualifiedName: $branchName) {
            target {
              ... on Commit {
                oid
                tree {
                  oid
                }
              }
            }
          }
        }
      }
    `;

    const branchResult = await request(graphqlEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
      },
      query: branchQuery,
      variables: {
        owner: repoOwner,
        name: repoName,
        branchName: `refs/heads/${branchName}`,
      },
    });

    const currentCommitSHA = branchResult.repository.ref.target.oid;
    const baseTreeSHA = branchResult.repository.ref.target.tree.oid;

    // Step 2: Create Blobs for Modified or New Files
    const files = JSON.parse(filesJson);
    const blobs = await Promise.all(
      files.map(async (filePath) => {
        const content = readFileSync(join(process.cwd(), filePath), "utf-8");
        const createBlobMutation = `
          mutation ($owner: String!, $name: String!, $content: Base64String!) {
            createBlob(input: {repositoryId: "REPO_ID", content: $content, encoding: BASE64}) {
              blob {
                oid
              }
            }
          }
        `;

        const blobResult = await request(graphqlEndpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${githubToken}`,
          },
          query: createBlobMutation,
          variables: {
            owner: repoOwner,
            name: repoName,
            content: Buffer.from(content).toString("base64"),
          },
        });

        return { path: filePath, sha: blobResult.createBlob.blob.oid };
      })
    );

    // Step 3: Create a New Tree
    const createTreeQuery = `
      mutation ($owner: String!, $name: String!, $baseTree: String!, $treeItems: [TreeItemInput!]!) {
        createTree(input: {repositoryId: "REPO_ID", baseTree: $baseTree, tree: $treeItems}) {
          tree {
            oid
          }
        }
      }
    `;

    const treeItems = blobs.map(({ path, sha }) => ({
      path,
      mode: "100644",
      type: "blob",
      sha,
    }));

    const treeResult = await request(graphqlEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
      },
      query: createTreeQuery,
      variables: {
        owner: repoOwner,
        name: repoName,
        baseTree: baseTreeSHA,
        treeItems,
      },
    });

    const newTreeSHA = treeResult.createTree.tree.oid;

    // Step 4: Create a New Commit
    const createCommitQuery = `
      mutation ($owner: String!, $name: String!, $message: String!, $treeSHA: String!, $parentSHA: String!) {
        createCommit(input: {repositoryId: "REPO_ID", message: $message, tree: $treeSHA, parents: [$parentSHA]}) {
          commit {
            oid
          }
        }
      }
    `;

    const commitResult = await request(graphqlEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
      },
      query: createCommitQuery,
      variables: {
        owner: repoOwner,
        name: repoName,
        message: commitMessage,
        treeSHA: newTreeSHA,
        parentSHA: currentCommitSHA,
      },
    });

    const newCommitSHA = commitResult.createCommit.commit.oid;

    // Step 5: Update the Branch Reference
    const updateRefQuery = `
      mutation ($owner: String!, $name: String!, $ref: String!, $commitSHA: String!) {
        updateRef(input: {repositoryId: "REPO_ID", ref: $ref, oid: $commitSHA, force: true}) {
          ref {
            name
          }
        }
      }
    `;

    await request(graphqlEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
      },
      query: updateRefQuery,
      variables: {
        owner: repoOwner,
        name: repoName,
        ref: `refs/heads/${branchName}`,
        commitSHA: newCommitSHA,
      },
    });

    console.log("Modified or new files updated in branch successfully!");
  } catch (error) {
    console.error("Error updating branch:", error.message);
  }
})();
