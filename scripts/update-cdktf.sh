#!/bin/bash

set -ex

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd)
CDKTF_VERSION=$1

echo "Updating to cdktf version $CDKTF_VERSION"

git checkout -b cdktf-update-$CDKTF_VERSION

cd $PROJECT_ROOT/infrastructure

yarn add -D cdktf-cli@$CDKTF_VERSION
yarn add cdktf@$CDKTF_VERSION @cdktf/provider-aws@latest @cdktf/provider-null@latest

git add --all

git commit -m "chore: update cdktf to $CDKTF_VERSION"
git push origin cdktf-update-$CDKTF_VERSION

gh pr create -f --base main --head cdktf-update-$CDKTF_VERSION --title "chore: update cdktf to $CDKTF_VERSION" --label "cdktf-update-$CDKTF_VERSION"

