#!/bin/sh
# Auto-increment build number using Xcode Cloud's build number
cd "$CI_PRIMARY_REPOSITORY_PATH/Still/Still"
agvtool new-version -all "$CI_BUILD_NUMBER"
