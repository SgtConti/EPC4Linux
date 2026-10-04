#!/bin/sh
# Runs the app and driver against stand-ins of the Hubitat API (HubStubs.groovy) through the scenarios in
# scenarios.groovy. Needs a JDK and Groovy 2.4 (the hub's Groovy version), e.g. JAVA_HOME=… GROOVY_HOME=… ./run.sh
# Not a substitute for a real hub: it checks the logic and that the code compiles, not the hub's sandbox or devices.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
groovy=${GROOVY_HOME:+$GROOVY_HOME/bin/}groovy
groovyc=${GROOVY_HOME:+$GROOVY_HOME/bin/}groovyc
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
"$groovyc" -d "$out" "$here/HubStubs.groovy"
"$groovy" -cp "$out" "$here/scenarios.groovy" "$here/../.."
