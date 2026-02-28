#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════╗"
echo "║     crucible — GitHub setup      ║"
echo "╚══════════════════════════════════╝"
echo ""

if ! command -v gh &>/dev/null; then
  echo "Installing GitHub CLI..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
    https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt update -qq && sudo apt install -y gh
fi

echo "GitHub CLI $(gh --version | head -1)"
echo ""

if gh auth status &>/dev/null; then
  echo "Already authenticated:"
  gh auth status
else
  echo "Starting GitHub login..."
  gh auth login --web --git-protocol ssh
fi

echo ""

GIT_NAME=$(git config --global user.name 2>/dev/null || true)
GIT_EMAIL=$(git config --global user.email 2>/dev/null || true)

if [ -z "$GIT_NAME" ]; then
  read -rp "Name for git commits: " GIT_NAME
  git config --global user.name "$GIT_NAME"
fi
if [ -z "$GIT_EMAIL" ]; then
  read -rp "Email for git commits: " GIT_EMAIL
  git config --global user.email "$GIT_EMAIL"
fi

echo ""
echo "Git identity: $GIT_NAME <$GIT_EMAIL>"
echo "GitHub setup complete."
echo ""
