#!/usr/bin/env bash
#
# Cursor Control Plane installer (per-user, no sudo).
#
# Clones (or upgrades) the project, installs dependencies, builds it, and adds a
# `cursor-cp` launcher to ~/.local/bin.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xabaras/cursor-cp-cli/main/install.sh | bash
#   bash install.sh [--version <ref>] [--dir <path>] [--help]
#

# Must run under bash (the one-liner pipes to `bash`). Fail clearly under sh/dash.
if [ -z "${BASH_VERSION:-}" ]; then
    echo "This installer requires bash. Re-run it with:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/xabaras/cursor-cp-cli/main/install.sh | bash" >&2
    exit 1
fi

set -euo pipefail

# --- Settings ---------------------------------------------------------------

readonly REPO_URL="https://github.com/xabaras/cursor-cp-cli.git"
readonly MIN_NODE_MAJOR=20

INSTALL_DIR="${CURSOR_CP_INSTALL_DIR:-$HOME/.local/share/cursor-cp}"
VERSION="${CURSOR_CP_VERSION:-latest}"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/cursor-cp"

# --- Output helpers ---------------------------------------------------------

if [ -t 1 ]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

log()     { printf '%s[cursor-cp]%s %s\n' "$BLUE" "$NC" "$1"; }
warn()    { printf '%s[warning]%s %s\n' "$YELLOW" "$NC" "$1" >&2; }
success() { printf '%s[ok]%s %s\n' "$GREEN" "$NC" "$1"; }
die()     { printf '%s[error]%s %s\n' "$RED" "$NC" "$1" >&2; exit 1; }

usage() {
    cat <<EOF
Cursor Control Plane installer

Usage: install.sh [OPTIONS]

Options:
  --version <ref>   Git tag or branch to install (default: latest / main)
  --dir <path>      Install directory (default: ~/.local/share/cursor-cp)
  --help, -h        Show this help

Environment:
  CURSOR_CP_VERSION       Same as --version
  CURSOR_CP_INSTALL_DIR   Same as --dir
EOF
}

# --- Argument parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --version)  [ $# -ge 2 ] || die "--version requires a value"; VERSION="$2"; shift 2 ;;
        --dir)      [ $# -ge 2 ] || die "--dir requires a value"; INSTALL_DIR="$2"; shift 2 ;;
        --help|-h)  usage; exit 0 ;;
        *)          die "Unknown option: $1 (try --help)" ;;
    esac
done

LAUNCHER="$BIN_DIR/cursor-cp"

# --- Prerequisite checks ----------------------------------------------------

check_prerequisites() {
    log "Checking prerequisites..."

    case "$(uname -s)" in
        Linux*|Darwin*) ;;
        *) die "Unsupported OS: $(uname -s). This installer supports Linux and macOS." ;;
    esac

    command -v git  >/dev/null 2>&1 || die "git is required. Install it and try again."
    command -v node >/dev/null 2>&1 || die "Node.js ${MIN_NODE_MAJOR}+ is required: https://nodejs.org/"
    command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

    local node_major
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
        die "Node.js ${MIN_NODE_MAJOR}+ is required. Found $(node -v)."
    fi
    log "Found Node.js $(node -v)"

    command -v gh >/dev/null 2>&1 || warn "GitHub CLI (gh) not found — GitHub repo browsing/cloning will be disabled."
}

# --- Install / upgrade ------------------------------------------------------

clone_or_update() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        log "Upgrading existing install at $INSTALL_DIR"
        git -C "$INSTALL_DIR" fetch --tags --prune origin
        if [ "$VERSION" = "latest" ]; then
            git -C "$INSTALL_DIR" checkout main >/dev/null 2>&1 || git -C "$INSTALL_DIR" checkout master
            git -C "$INSTALL_DIR" pull --ff-only origin "$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
        else
            git -C "$INSTALL_DIR" checkout "$VERSION"
        fi
    elif [ -e "$INSTALL_DIR" ]; then
        die "$INSTALL_DIR exists but is not a git checkout. Remove it or pass --dir <path>."
    else
        log "Cloning into $INSTALL_DIR"
        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone "$REPO_URL" "$INSTALL_DIR"
        if [ "$VERSION" != "latest" ]; then
            git -C "$INSTALL_DIR" checkout "$VERSION"
        fi
    fi
}

build_app() {
    log "Installing dependencies..."
    if [ -f "$INSTALL_DIR/package-lock.json" ]; then
        ( cd "$INSTALL_DIR" && npm ci )
    else
        ( cd "$INSTALL_DIR" && npm install )
    fi

    log "Building..."
    ( cd "$INSTALL_DIR" && npm run build )
}

resolve_node_bin() {
    local node_bin
    node_bin="$(command -v node 2>/dev/null || true)"
    if [ -z "$node_bin" ]; then
        for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
            if [ -x "$candidate" ]; then
                node_bin="$candidate"
                break
            fi
        done
    fi
    [ -n "$node_bin" ] || die "node is required but was not found on PATH."
    printf '%s' "$node_bin"
}

create_launcher() {
    local node_bin
    node_bin="$(resolve_node_bin)"
    mkdir -p "$BIN_DIR"
    cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Cursor Control Plane launcher (generated by install.sh)
INSTALL_DIR="${INSTALL_DIR}"
NODE="${node_bin}"
if ! [ -x "\$NODE" ]; then
    NODE="\$(command -v node 2>/dev/null || true)"
fi
if ! [ -x "\$NODE" ]; then
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
        if [ -x "\$candidate" ]; then
            NODE="\$candidate"
            break
        fi
    done
fi
if ! [ -x "\$NODE" ]; then
    echo "cursor-cp: node not found (install Node.js 20+)" >&2
    exit 127
fi
exec "\$NODE" "\${INSTALL_DIR}/dist/cli/index.js" "\$@"
EOF
    chmod +x "$LAUNCHER"
    log "Installed launcher at $LAUNCHER (node: $node_bin)"
}

init_user_config() {
    local user_config="$HOME/cursor-cp/config.yaml"
    local defaults="$INSTALL_DIR/config.default.yaml"
    mkdir -p "$HOME/cursor-cp"
    if [ ! -f "$user_config" ]; then
        cp "$defaults" "$user_config"
        chmod 600 "$user_config" 2>/dev/null || true
        log "Created $user_config from config.default.yaml"
    fi
}

refresh_daemon_if_enabled() {
    local marker="$HOME/cursor-cp/data/service.json"
    local plist="$HOME/Library/LaunchAgents/com.cursor.cp.plist"
    local unit="$HOME/.config/systemd/user/cursor-cp.service"

    if [ ! -f "$marker" ] && [ ! -f "$plist" ] && [ ! -f "$unit" ]; then
        return
    fi

    local node_bin
    node_bin="$(resolve_node_bin)"
    log "Updating background daemon configuration..."
    if "$node_bin" "${INSTALL_DIR}/dist/cli/index.js" daemon enable; then
        success "Background daemon updated"
    else
        warn "Could not update daemon. Run: cursor-cp daemon enable"
    fi
}

# --- Summary ----------------------------------------------------------------

print_summary() {
    printf '\n'
    success "Cursor Control Plane installed at $INSTALL_DIR"

    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:
    export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac

    cat <<EOF

Next step — configure cursor-cp:
  cursor-cp setup

Useful commands:
  cursor-cp setup     configure API key, model, port, Telegram, daemon
  cursor-cp           start the server (http://localhost:8747)
  cursor-cp doctor    check your installation
  cursor-cp --help    all commands

EOF
}

# --- Main -------------------------------------------------------------------

main() {
    printf '%sCursor Control Plane installer%s\n\n' "$BLUE" "$NC"
    check_prerequisites
    clone_or_update
    build_app
    create_launcher
    init_user_config
    refresh_daemon_if_enabled
    print_summary
}

main
