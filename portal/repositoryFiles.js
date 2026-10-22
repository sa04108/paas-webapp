"use strict";

const { AppError } = require("./utils");
const { isDockerfileName } = require("../scripts/lib/build-config");

// 사용자 URL을 외부 요청 주소로 사용하지 않고 GitHub 저장소 식별자만 추출한다.
function parseGithubRepository(repoUrl) {
  let url;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new AppError(400, "Enter a valid GitHub repository URL");
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "github.com" ||
      url.port || url.username || url.password || url.search || url.hash || !match) {
    throw new AppError(400, "Dockerfile lookup supports github.com repository URLs only");
  }
  const repo = match[2].replace(/\.git$/, "");
  if (!repo || repo === "." || repo === "..") {
    throw new AppError(400, "Enter a valid GitHub repository URL");
  }
  return { owner: match[1], repo };
}

async function listRootDockerfiles(repoUrl, branch, token = "") {
  const { owner, repo } = parseGithubRepository(repoUrl);
  if (typeof branch !== "string" || !branch.trim() || branch.length > 1024 || /[\x00-\x1f\x7f]/.test(branch)) {
    throw new AppError(400, "Enter a valid branch name");
  }
  const ref = branch.trim();
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents`);
  url.searchParams.set("ref", ref);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "paas-portal",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      if (response.status === 404) {
        throw new AppError(404, "Repository or branch not found, or access is not permitted");
      }
      if (response.status === 403 || response.status === 429) {
        throw new AppError(response.status, "GitHub access was denied or its API rate limit was reached. Try again later.");
      }
      throw new AppError(502, "GitHub repository lookup failed");
    }
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new AppError(502, "Invalid GitHub directory response");
    if (entries.length >= 1000) {
      throw new AppError(422, "This repository root is too large for Dockerfile lookup. Use automatic detection or a custom Dockerfile.");
    }
    const files = entries
      .filter((entry) => entry.type === "file" && !entry.submodule_git_url &&
        entry.path === entry.name && isDockerfileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a === b ? 0 : a === "Dockerfile" ? -1 : b === "Dockerfile" ? 1 :
        Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return { files, branch: ref };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "Unable to query GitHub. Check the repository URL and try again.");
  }
}

module.exports = { parseGithubRepository, listRootDockerfiles };
