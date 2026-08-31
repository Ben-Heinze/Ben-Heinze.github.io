# Scaffold a new page + nav entry and rebuild.
# Parent is a content/ path (omit for top level).
# Usage: just new-page "Gradient Descent" ai/machine-learning
new-page title parent="":
    python3 serve.py new-page "{{title}}" "{{parent}}"

# Delete a page + its nav entry and rebuild. The inverse of new-page.
# Pass the content/ path of the page (any pages nested under it go too).
# Usage: just delete-page ai/machine-learning
delete-page path:
    python3 serve.py delete-page "{{path}}"

# Move a page (and any pages nested under it) to a new parent, rewriting its
# nav entry and content/ + public/ dirs in place. Omit parent for top level.
# Usage: just move-page statistics/likelihood ai
move-page path parent="":
    python3 serve.py move-page "{{path}}" "{{parent}}"

# Rename a page: give it a new title, re-deriving its URL slug and dir from the
# title, updating its #+TITLE: and nav label, and keeping the same parent. Any
# pages nested under it move with it. Pass the current content/ path.
# Usage: just rename-page statistics/likelihood "Maximum Likelihood"
rename-page path title:
    python3 serve.py rename-page "{{path}}" "{{title}}"

run:
    #!/usr/bin/env bash
    if [ -f .server.pid ] && kill -0 "$(cat .server.pid)" 2>/dev/null; then
        kill "$(cat .server.pid)"
    fi
    emacs --batch -l publish.el --eval "(org-publish-all t)"
    cp static/style.css public/style.css
    python3 serve.py &
    echo $! > .server.pid
    SERVER_PID=$!
    sleep 0.5
    xdg-open http://localhost:8080
    wait $SERVER_PID
