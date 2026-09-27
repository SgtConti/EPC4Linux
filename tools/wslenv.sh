# Source in WSL: environment for the user-local toolchain from setup_wsl_toolchain.sh
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export DOTNET_ROOT="$HOME/.dotnet"
export JAVA_HOME="$HOME/tools/jdk"
export PATH="$HOME/tools/node/bin:$HOME/.dotnet:$HOME/.dotnet/tools:$JAVA_HOME/bin:$PATH"
export REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
