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

# Set whether a page is published to the live website. A `private` page still
# appears under `just run` but is excluded from the deployed GitHub Pages site
# (both its HTML and its nav/TOC links). Set it back with `public`.
# Usage: just page-visibility job private
#        just page-visibility job public
page-visibility path visibility:
    python3 serve.py page-visibility "{{path}}" "{{visibility}}"

# Dump a PDF's text to parsed_pdfs/<name>.txt, ready to turn into org notes.
# Each line is prefixed with its font size and x offset: the biggest size on a
# page is its title, and the x offsets give you the bullet nesting.
# Pass extra flags straight through: --pages 1,4,7 (just those pages),
# --forms (also read Form XObjects, where diagram labels live), --plain (no prefix).
# Usage: just parse-pdf content/ai/machine-learning/syllabus.pdf --pages 1,2
#        just parse-pdf "unparsed_pdfs/Week 5 Notes.pdf"
parse-pdf pdf *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    out="parsed_pdfs/$(basename "{{pdf}}" .pdf).txt"
    mkdir -p parsed_pdfs
    python3 pdftext.py "{{pdf}}" {{flags}} > "$out"
    pages=$(grep -c '^───── page' "$out" || true)
    printf '%s (%s lines, %s pages)\n' "$out" "$(wc -l < "$out")" "$pages"
    if [ "$pages" -eq 0 ]; then
        echo "  no text found — those pages are probably images; try --forms" >&2
    fi

run:
    #!/usr/bin/env bash
    if [ -f .server.pid ] && kill -0 "$(cat .server.pid)" 2>/dev/null; then
        kill "$(cat .server.pid)"
    fi
    WIKI_INCLUDE_LOCAL=1 emacs --batch -l publish.el --eval "(org-publish-all t)"
    cp static/style.css public/style.css
    python3 serve.py &
    echo $! > .server.pid
    SERVER_PID=$!
    sleep 0.5
    xdg-open http://localhost:8080
    wait $SERVER_PID
