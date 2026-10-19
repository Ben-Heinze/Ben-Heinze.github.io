# Scaffold a new page + nav entry and rebuild.
# Parent is a content/ path (omit for top level). Tags are optional; pass them as
# one comma-separated string (you must give a parent, even "", to reach them).
# Slug is the page's directory/URL name; it defaults to the slugified title, and
# you can give a shorter one to type ("Machine Learning" living at ml/).
# Usage: just new-page "Gradient Descent" ai/ml
#        just new-page "Gradient Descent" ai/ml "optimization, week-3"
#        just new-page "Operating Systems" "" "" os
new-page title parent="" tags="" slug="":
    python3 serve.py new-page "{{title}}" "{{parent}}" "{{tags}}" "{{slug}}"

# Tag a page with one or more subjects, linking it to every other page sharing
# them: chips under its title, an entry on /tags/, and `tag:name` in search.
# The path is a content/ path — either a page directory ("os") or
# a standalone snippet page ("algorithms/fibonacci").
# Tags are slugs, so write multi-word ones hyphenated: "dynamic-programming", not
# "Dynamic Programming" — just splits variadic arguments on whitespace whatever
# you quote, so a phrase would become two separate tags. Commas work too.
# A tag that closely resembles an existing one is treated as a typo and stops,
# since that near miss is almost certainly what you meant; --new means it.
# Usage: just tag-page ai/ml/lectures/5-tree-learning week-5 entropy
#        just tag-page algorithms/fibonacci dynamic-programming,memoization
#        just tag-page os paging --new
tag-page path *tags:
    python3 serve.py tag-page "{{path}}" {{tags}}

# Remove one or more tags from a page. The inverse of tag-page; taking the last
# tag off a page removes its #+TAGS: line entirely.
# Usage: just untag-page ai/ml/lectures/5-tree-learning entropy
untag-page path *tags:
    python3 serve.py untag-page "{{path}}" {{tags}}

# Show the wiki's tags. With no argument, every tag and how many pages use it
# (most-used first). With a content/ path, just that page's tags. With
# --untagged, every page carrying no tags yet — the backfill worklist.
# Usage: just list-tags
#        just list-tags ai/ml
#        just list-tags --untagged
list-tags *args:
    python3 serve.py list-tags {{args}}

# Delete a page + its nav entry and rebuild. The inverse of new-page.
# Pass the content/ path of the page (any pages nested under it go too).
# Usage: just delete-page ai/ml
delete-page path:
    python3 serve.py delete-page "{{path}}"

# Move a page (and any pages nested under it) to a new parent, rewriting its
# nav entry and content/ + public/ dirs in place. Omit parent for top level.
# Usage: just move-page statistics/likelihood ai
move-page path parent="":
    python3 serve.py move-page "{{path}}" "{{parent}}"

# Rename a page: give it a new title, updating its #+TITLE: and nav label and
# keeping the same parent. Any pages nested under it move with it. Pass the
# current content/ path. The URL slug follows the title only if it was derived
# from the old title; a hand-picked slug (set-slug) is kept. Pass a slug to set
# both at once.
# Usage: just rename-page statistics/likelihood "Maximum Likelihood"
#        just rename-page ai/ml "Statistical Learning" stat-learning
rename-page path title slug="":
    python3 serve.py rename-page "{{path}}" "{{title}}" "{{slug}}"

# Change only a page's URL slug (its directory under content/), keeping its
# title and nav label, so a long title can live at a short path you type often.
# Nested pages move with it, and quiz ratings are carried over to the new ids.
# Usage: just set-slug ai/machine-learning ml
set-slug path slug:
    python3 serve.py set-slug "{{path}}" "{{slug}}"

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
# Usage: just parse-pdf content/ai/ml/syllabus.pdf --pages 1,2
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

# Merge a browser "Export ratings" download into question-ratings.json.
# The deployed site has no /api/rating endpoint, so a verdict made there lives
# only in that browser; "Export ratings" in the quiz toolbar downloads it and
# this folds it back in. Keyed by question id, newest `updated` wins, so it is
# safe to run twice.
# Usage: just merge-ratings ~/Downloads/question-ratings-export.json
merge-ratings file:
    python3 serve.py merge-ratings "{{file}}"
