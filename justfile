# Scaffold a new page + nav entry and rebuild, like the "+ New page" button.
# Parent is a content/ path (omit for top level).
# Usage: just new-page "Gradient Descent" ai/machine-learning
new-page title parent="":
    python3 serve.py new-page "{{title}}" "{{parent}}"

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
