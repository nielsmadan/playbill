[private]
default:
    @just --list

install:
    @npm ci
    @npm run build
    @npm install --global --install-links --force .

install-editable:
    @npm ci
    @npm run build
    @npm link

uninstall:
    @npm uninstall --global @playbill/core
