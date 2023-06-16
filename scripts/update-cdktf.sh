#!/bin/bash

set -ex

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd)
CDKTF_VERSION=$1

echo "Updating to cdktf version $CDKTF_VERSION"
cd $PROJECT_ROOT/infrastructure

yarn add -D cdktf-cli@$CDKTF_VERSION
yarn add cdktf@$CDKTF_VERSION @cdktf/provider-aws@latest @cdktf/provider-null@latest
