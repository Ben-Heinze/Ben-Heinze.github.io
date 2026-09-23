;;; publish.el --- Build the wiki: emacs --batch -l publish.el -f org-publish-all
;;; Serve output with: python3 -m http.server 8080 --directory public/

(require 'org)
(require 'ox-html)
(require 'json)
(require 'seq)
(require 'oc)
(require 'oc-basic)

;; ── Citations ───────────────────────────────────────────────────────────
;; A single shared main.bib at the repo root backs every page — pages just
;; cite with [cite:@key] and don't need their own #+bibliography: keyword.
;; Numeric style keeps citations terse since prose already names authors.
;;
;; The stock "basic" processor doesn't hyperlink a citation to its
;; bibliography entry, so wiki-cite wraps it: identical numbering/formatting,
;; but each number becomes an <a href="#citeref-KEY"> and each bibliography
;; entry gets a matching id, so clicking a citation jumps to its reference.
(setq org-cite-global-bibliography (list (expand-file-name "main.bib" default-directory)))

(defun wiki-cite-export-citation (citation style _backend info)
  "Like `org-cite-basic-export-citation', but link each number to its entry."
  (let* ((keys (org-cite-get-references citation t))
         (number->key (mapcar (lambda (k) (cons (org-cite-basic--key-number k info) k))
                               keys))
         (text (org-cite-basic-export-citation citation style nil info)))
    (replace-regexp-in-string
     "[0-9]+"
     (lambda (n)
       (let ((key (cdr (assoc (string-to-number n) number->key))))
         (if key (format "<a href=\"#citeref-%s\">%s</a>" key n) n)))
     text)))

(defun wiki-cite-export-bibliography (keys _files style _props _backend info)
  "Like `org-cite-basic-export-bibliography', but anchor each entry by its
key so `wiki-cite-export-citation' links can jump straight to it."
  (mapconcat
   (lambda (entry)
     (org-export-data
      (org-cite-make-paragraph
       (org-export-raw-string
        (format "<span id=\"citeref-%s\"></span>" (cdr (assq 'id entry))))
       (org-cite-basic--print-entry entry style info))
      info))
   (delq nil (mapcar (lambda (k) (org-cite-basic--get-entry k info))
                      (org-cite-basic--sort-keys keys info)))
   "\n"))

(org-cite-register-processor 'wiki-cite
  :export-citation #'wiki-cite-export-citation
  :export-bibliography #'wiki-cite-export-bibliography)

(setq org-cite-export-processors
      '((html wiki-cite "numeric" "numeric")
        (t basic "numeric" "numeric")))

(org-babel-do-load-languages
 'org-babel-load-languages
 '((python      . t)
   (R           . t)
   (shell       . t)
   (emacs-lisp  . t)))

(setq org-confirm-babel-evaluate nil)
;; Use stored #+RESULTS: during export — run blocks interactively in Emacs first
(setq org-export-babel-evaluate nil)

;; Math rendering is handled by Org's own built-in MathJax support
;; (`:with-latex' defaults to `t', which org-html triggers automatically
;; whenever a page contains a LaTeX fragment/environment). Previously this
;; head also hand-rolled its own MathJax <script> config, which loaded a
;; second, separate MathJax bootstrap alongside Org's own — two copies of
;; MathJax racing to initialize on every math-containing page, which is
;; what was causing math to render inconsistently. Org's default template
;; already emits sane inlineMath/displayMath delimiters matching the
;; \( \) / \[ \] Org normalizes fragments to, so nothing needs configuring.
;;
;; One gap in Org's default template: it has no slot for custom TeX macros.
;; Pages use \textsc{...} (e.g. \textsc{Pass}, \textsc{Good}) as state labels
;; in math — valid LaTeX, but not a macro MathJax's tex input ships with, so
;; it rendered as a broken "undefined control sequence" in the browser
;; instead of the label. Override the template to add a macros block mapping
;; \textsc to MathJax's own \text, so it degrades to plain upright text
;; instead of failing.
(setq org-html-mathjax-template
      "<script>
  window.MathJax = {
    tex: {
      ams: {
        multlineWidth: '%MULTLINEWIDTH'
      },
      tags: '%TAGS',
      tagSide: '%TAGSIDE',
      tagIndent: '%TAGINDENT',
      macros: {
        textsc: ['\\\\text{#1}', 1]
      }
    },
    chtml: {
      scale: %SCALE,
      displayAlign: '%ALIGN',
      displayIndent: '%INDENT'
    },
    svg: {
      scale: %SCALE,
      displayAlign: '%ALIGN',
      displayIndent: '%INDENT'
    },
    output: {
      font: '%FONT',
      displayOverflow: '%OVERFLOW'
    }
  };
</script>

<script
  id=\"MathJax-script\"
  async
  src=\"%PATH\">
</script>
")

;; ── Pseudocode blocks ───────────────────────────────────────────────────
;; MathJax only renders text inside math delimiters (\( \) / \[ \]), so bare
;; LaTeX pseudocode (\mathcal{Z} \gets \emptyset ...) written directly in a
;; page exports as literal text. The `pseudocode' special block fixes that:
;;
;;   #+begin_pseudocode
;;   \mathcal{Z} \gets \emptyset
;;   \textbf{repeat}
;;   \quad \textbf{for all } x \in \mathcal{X}
;;   #+end_pseudocode
;;
;; Each line becomes one row of a left-aligned array inside an equation*
;; environment, wrapped in a quote block for the usual indent/styling. Write
;; one statement per line (no trailing \\ needed — any present are stripped),
;; use \quad / \qquad for indentation, and \text{...} / \textbf{...} for
;; prose words. Works for both MathJax (HTML) and PDF export.
(defun wiki-expand-pseudocode-blocks (_backend)
  "Rewrite #+begin_pseudocode blocks into display-math the exporter renders."
  (goto-char (point-min))
  (while (re-search-forward "^[ \t]*#\\+begin_pseudocode[ \t]*$" nil t)
    (let ((start (match-beginning 0))
          (body-start (line-beginning-position 2)))
      (when (re-search-forward "^[ \t]*#\\+end_pseudocode[ \t]*$" nil t)
        (let* ((body-end (match-beginning 0))
               (end (match-end 0))
               (lines (seq-remove
                       #'string-empty-p
                       (mapcar (lambda (l)
                                 ;; Strip any trailing \\ so rows aren't doubled.
                                 (string-trim
                                  (replace-regexp-in-string "\\\\\\\\[ \t]*\\'" ""
                                                            (string-trim l))))
                               (split-string
                                (buffer-substring-no-properties body-start body-end)
                                "\n")))))
          (delete-region start end)
          (goto-char start)
          ;; flalign* (not equation*) so the block sits flush left instead of
          ;; centered; the lone & pins the array to the left margin.
          (insert "#+begin_quote\n\\begin{flalign*}\n&\\begin{array}{l}\n"
                  (mapconcat #'identity lines " \\\\\n")
                  "\n\\end{array}&&\n\\end{flalign*}\n#+end_quote"))))))

(add-hook 'org-export-before-processing-functions #'wiki-expand-pseudocode-blocks)

;; The inline theme script runs before the body paints so the stored (or
;; system-preferred) light/dark theme is applied with no flash of the wrong
;; palette. It only sets the data-theme attribute the CSS keys off of; the
;; toggle button's click handler lives in new-page.js.
;; Mermaid diagrams: pages emit their graph as a <pre class="mermaid"> block
;; (see the `mermaid' export helper / raw export blocks in content). Mermaid
;; isn't bundled — this bootstrap dynamically imports it from the CDN only on
;; pages that actually contain a diagram, renders every .mermaid block, then
;; re-runs MathJax over the freshly drawn SVGs so \( \) labels inside nodes
;; typeset like the rest of the page's math. It waits for MathJax's own startup
;; promise first so the retypeset can't race the async MathJax bootstrap.
(defvar wiki-html-head
  "<link rel=\"stylesheet\" href=\"/style.css?v=14\" />
<script>(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<script>document.addEventListener('DOMContentLoaded',function(){if(!document.querySelector('.mermaid'))return;var s=document.createElement('script');s.type='module';s.textContent=\"import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';import elk from 'https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@1.0.0/dist/mermaid-layout-elk.esm.min.mjs';mermaid.registerLayoutLoaders(elk);var dark=document.documentElement.getAttribute('data-theme')==='dark';mermaid.initialize({startOnLoad:false,securityLevel:'loose',theme:dark?'dark':'neutral',layout:'elk',flowchart:{curve:'linear',nodeSpacing:55,rankSpacing:75}});await mermaid.run({querySelector:'.mermaid'});if(window.MathJax&&window.MathJax.startup&&window.MathJax.typesetPromise){await window.MathJax.startup.promise;await window.MathJax.typesetPromise(Array.from(document.querySelectorAll('.mermaid')));}\";document.head.appendChild(s);});</script>")

;; ── Navigation ──────────────────────────────────────────────────────────
;; The nav bar is generated from nav.json (a single source of truth shared
;; with serve.py, which appends to it when a new page is created via
;; `just new-page`). Tabs are root-relative so they resolve from any
;; subdirectory.

;; ── Private pages ─────────────────────────────────────────────────────────
;; A nav entry marked "private": true in nav.json is kept out of the deployed
;; site: its HTML/assets are not published and it is dropped from the sidebar
;; and homepage TOC. This is the DEFAULT behavior here, so the live GitHub Pages
;; build (which runs publish.el plainly) never leaks a private page. Setting the
;; WIKI_INCLUDE_LOCAL env var — which `just run` and serve.py do, but CI does
;; not — flips every gate below off, so private pages build and show locally.
;; Toggle a page's flag with `just page-visibility <path> private|public`.
(defvar wiki-include-local (and (getenv "WIKI_INCLUDE_LOCAL") t)
  "When non-nil, publish pages marked \"private\" in nav.json too (local dev).")

(defun wiki-href-to-dir (href)
  "Content-relative directory for nav HREF: \"/job/index.html\" -> \"job\"."
  (let ((s (replace-regexp-in-string "/index\\.html\\'" "" (or href ""))))
    (replace-regexp-in-string "\\`/" "" s)))

(defun wiki-private-dirs (items)
  "Collect the content-relative dirs of every entry in ITEMS (recursing into
children) whose 'private flag is set. A private parent contributes its dir,
which covers its whole subtree."
  (let (dirs)
    (dolist (item items)
      (when (alist-get 'private item)
        (push (wiki-href-to-dir (alist-get 'href item)) dirs))
      (setq dirs (append dirs (wiki-private-dirs (alist-get 'children item)))))
    dirs))

(defun wiki-nav-filter-local (items)
  "Return ITEMS with private entries (and their subtrees) removed. When
`wiki-include-local' is non-nil, ITEMS is returned unchanged so private pages
appear locally."
  (if wiki-include-local
      items
    (delq nil
          (mapcar (lambda (item)
                    (unless (alist-get 'private item)
                      (let ((cell (assq 'children item)))
                        (when cell
                          (setcdr cell (wiki-nav-filter-local (cdr cell)))))
                      item))
                  items))))

(defun wiki-html-escape (s)
  "Escape &, <, > in S for safe insertion into HTML."
  (setq s (replace-regexp-in-string "&" "&amp;" s t t))
  (setq s (replace-regexp-in-string "<" "&lt;" s t t))
  (replace-regexp-in-string ">" "&gt;" s t t))

(defun wiki-nav-link (item)
  "Render an anchor for nav ITEM (an alist with 'label and 'href)."
  (format "<a href=\"%s\">%s</a>"
          (alist-get 'href item)
          (wiki-html-escape (alist-get 'label item))))

(defun wiki-nav-item (item)
  "Render one nav ITEM as an <li>: a row (collapse toggle + link) and, when the
item has children, the nested subtree that the toggle collapses."
  (let* ((children (alist-get 'children item))
         (toggle (if children
                     "<button type=\"button\" class=\"nav-toggle\" aria-expanded=\"true\" aria-label=\"Toggle section\"></button>"
                   "<span class=\"nav-toggle-spacer\" aria-hidden=\"true\"></span>"))
         ;; A private entry only ever renders in the local build (see the
         ;; "Private pages" note), so mark it with a lock so you can tell at a
         ;; glance which pages won't appear on the live site.
         (badge (if (alist-get 'private item)
                    "<span class=\"nav-private\" title=\"Private — visible locally, not published to the live site\" aria-label=\"Private\">\N{LOCK}</span>"
                  "")))
    (concat "<li>"
            "<div class=\"nav-row\">" toggle (wiki-nav-link item) badge "</div>"
            (if children (concat "\n" (wiki-nav-tree children) "\n") "")
            "</li>")))

(defun wiki-nav-tree (items)
  "Render ITEMS (a list of nav alists) as a nested <ul>, recursing to any depth."
  (concat
   "<ul class=\"nav-tree\">\n"
   (mapconcat #'wiki-nav-item items "\n")
   "\n</ul>"))

(defun wiki-nav-natural-less (s1 s2)
  "Natural-order comparison of S1 and S2 (case-insensitive).
Runs of digits are compared by numeric value, so \"7\" sorts before \"20\"."
  (let ((a (downcase (or s1 ""))) (b (downcase (or s2 "")))
        (i 0) (j 0) (result nil) (done nil))
    (while (not done)
      (let ((la (length a)) (lb (length b)))
        (cond
         ((and (>= i la) (>= j lb)) (setq done t result nil))
         ((>= i la) (setq done t result t))
         ((>= j lb) (setq done t result nil))
         ((and (>= (aref a i) ?0) (<= (aref a i) ?9)
               (>= (aref b j) ?0) (<= (aref b j) ?9))
          ;; Both positions start a digit run: compare numerically.
          (let ((si i) (sj j))
            (while (and (< i la) (>= (aref a i) ?0) (<= (aref a i) ?9)) (setq i (1+ i)))
            (while (and (< j lb) (>= (aref b j) ?0) (<= (aref b j) ?9)) (setq j (1+ j)))
            (let ((na (string-to-number (substring a si i)))
                  (nb (string-to-number (substring b sj j))))
              (cond ((< na nb) (setq done t result t))
                    ((> na nb) (setq done t result nil))))))
         (t
          (cond ((< (aref a i) (aref b j)) (setq done t result t))
                ((> (aref a i) (aref b j)) (setq done t result nil))
                (t (setq i (1+ i) j (1+ j))))))))
    result))

(defun wiki-nav-less (a b)
  "Ordering predicate for two nav items: natural order by label (case-insensitive).
The Home entry (href \"/index.html\") always sorts first, and Search
(href \"/search/index.html\") is pinned right below it; everything else is
alphabetical."
  (let ((ha (alist-get 'href a)) (hb (alist-get 'href b)))
    (cond ((string= ha "/index.html") t)
          ((string= hb "/index.html") nil)
          ((string= ha "/search/index.html") t)
          ((string= hb "/search/index.html") nil)
          (t (wiki-nav-natural-less (alist-get 'label a)
                                    (alist-get 'label b))))))

(defun wiki-nav-sort (items)
  "Return ITEMS sorted alphabetically by label at every level of the hierarchy."
  (let ((sorted (sort (copy-sequence items) #'wiki-nav-less)))
    (dolist (item sorted sorted)
      (let ((cell (assq 'children item)))
        (when cell (setcdr cell (wiki-nav-sort (cdr cell))))))))

(defun wiki-build-preamble ()
  "Build the sidebar preamble HTML from nav.json."
  (let* ((json-array-type 'list)
         (json-object-type 'alist)
         (json-key-type 'symbol)
         ;; Sort the whole hierarchy alphabetically so the sidebar and the
         ;; Location picker order stays consistent regardless of nav.json order.
         ;; Private pages are filtered out first (unless building locally).
         (nav (wiki-nav-sort
               (wiki-nav-filter-local (json-read-file "nav.json")))))
    (concat
     "<a class=\"site-title\" href=\"/index.html\">yappopotamus</a>\n"
     "<nav>\n"
     (wiki-nav-tree nav)
     "\n</nav>\n"
     ;; Light/dark theme toggle. Its label + icon are filled in by new-page.js
     ;; to match the active theme; it's inert markup until then.
     "<button type=\"button\" class=\"theme-toggle\" aria-label=\"Toggle light/dark theme\">"
     "<span class=\"theme-toggle-icon\" aria-hidden=\"true\"></span>"
     "<span class=\"theme-toggle-label\"></span>"
     "</button>\n"
     ;; Sidebar behavior lives in static/new-page.js (copied to public/ by the
     ;; wiki-static component). `defer` waits for the preamble DOM to parse.
     "<script src=\"/new-page.js?v=6\" defer></script>\n"
     ;; Site-wide search: the Ctrl/Cmd-K overlay and the /search/ page both live
     ;; in static/search.js (copied to public/ by the wiki-static component).
     "<script src=\"/search.js?v=1\" defer></script>\n"
     ;; Per-page Learn mode: a study/quiz overlay built from this page's cards in
     ;; /learn-index.json (generated by wiki-build-learn-index). Lives in
     ;; static/learn.js (copied to public/ by the wiki-static component).
     "<script src=\"/learn.js?v=1\" defer></script>")))

(defvar wiki-preamble (wiki-build-preamble))

;; ── Homepage table of contents ─────────────────────────────────────────
;; The homepage lists every top-level section (and what's inside it) in a
;; table. Rather than hand-maintaining that table in content/index.org, it's
;; generated from nav.json and spliced into the published index.html in
;; place of a placeholder div, via :completion-function below. This keeps
;; the homepage in sync automatically as sections are added or removed.
;;
;; The "Contents" cell is filled from the first of these that yields anything,
;; so every row says something and none are left blank:
;;   1. an explicit "summary" string on the nav entry (human-written), else
;;   2. the labels of the section's sub-pages (its nav children), else
;;   3. the section page's own top-level headings, read from its index.org.

(defconst wiki-toc-heading-limit 6
  "Max number of a section's own headings to list in the homepage table
before truncating with an ellipsis.")

(defun wiki-org-file-for-href (href)
  "Map a nav HREF like \"/spotify/index.html\" to its content/ .org source path."
  (let* ((rel (replace-regexp-in-string "/index\\.html\\'" "" (or href "")))
         (rel (replace-regexp-in-string "\\`/" "" rel)))
    (expand-file-name (concat "content/" rel "/index.org"))))

(defun wiki-clean-heading (h)
  "Tidy a raw Org heading H for display in the homepage table: drop trailing
:tags:, unwrap =verbatim=/~code~ markers, and normalize -- to an en dash."
  (setq h (string-trim h))
  (setq h (replace-regexp-in-string ":[[:alnum:]_@#%:]+:[ \t]*\\'" "" h))
  (setq h (replace-regexp-in-string "[=~]\\([^=~]+\\)[=~]" "\\1" h))
  (setq h (replace-regexp-in-string "--" "–" h))
  (string-trim h))

(defun wiki-section-headings (href)
  "Return up to `wiki-toc-heading-limit' top-level headings from the index.org
behind HREF, as a comma-separated string, or nil if the file has none.
Boilerplate headings (References/Footnotes) are skipped; an ellipsis is added
when more headings exist than are shown."
  (let ((file (wiki-org-file-for-href href))
        (heads '()))
    (when (file-readable-p file)
      (with-temp-buffer
        (insert-file-contents file)
        (goto-char (point-min))
        ;; Level-1 headings only: "* " but not "** ".
        (while (re-search-forward "^\\*[ \t]+\\(.*\\)$" nil t)
          (let ((h (wiki-clean-heading (match-string 1))))
            (unless (or (string-empty-p h)
                        (member (downcase h) '("references" "footnotes")))
              (push h heads))))))
    (setq heads (nreverse heads))
    (when heads
      (let ((shown (if (> (length heads) wiki-toc-heading-limit)
                       (append (seq-take heads wiki-toc-heading-limit) '("…"))
                     heads)))
        (mapconcat #'wiki-html-escape shown ", ")))))

(defun wiki-toc-row (item)
  "Render one <tr> for homepage nav ITEM: its link plus a summary of its
contents. See the comment above for how the contents cell is chosen."
  (let* ((children (alist-get 'children item))
         (summary (alist-get 'summary item))
         (contents
          (cond
           (summary (wiki-html-escape summary))
           (children (mapconcat (lambda (c) (wiki-html-escape (alist-get 'label c)))
                                children ", "))
           (t (or (wiki-section-headings (alist-get 'href item)) "&#8212;")))))
    (format "<tr><td><a href=\"%s\">%s</a></td><td>%s</td></tr>"
            (alist-get 'href item)
            (wiki-html-escape (alist-get 'label item))
            contents)))

(defun wiki-toc-table ()
  "Build the homepage table of contents HTML from nav.json."
  (let* ((json-array-type 'list)
         (json-object-type 'alist)
         (json-key-type 'symbol)
         (nav (wiki-nav-sort
               (wiki-nav-filter-local (json-read-file "nav.json"))))
         (sections (seq-remove (lambda (it) (string= (alist-get 'href it) "/index.html")) nav)))
    (concat "<table>\n<thead><tr><th>Section</th><th>Contents</th></tr></thead>\n<tbody>\n"
            (mapconcat #'wiki-toc-row sections "\n")
            "\n</tbody>\n</table>")))

(defun wiki-inject-toc (_project)
  "Replace the #wiki-toc placeholder div in the published homepage with a
table of contents generated from nav.json."
  (let ((file (expand-file-name "public/index.html")))
    (when (file-exists-p file)
      (with-temp-buffer
        (insert-file-contents file)
        (goto-char (point-min))
        (if (re-search-forward "<div id=\"wiki-toc\">" nil t)
            (let ((start (match-beginning 0)))
              (search-forward "</div>")
              (delete-region start (point))
              (goto-char start)
              (insert (wiki-toc-table))
              (write-region (point-min) (point-max) file))
          (message "wiki-inject-toc: #wiki-toc placeholder not found in %s" file))))))

;; ── Search index ───────────────────────────────────────────────────────────
;; A client-side Search feature (static/search.js + the /search/ page) needs a
;; full-text index of the wiki. Since the deployed site is static, the index is
;; a JSON file generated here at publish time and fetched by the browser.
;;
;; We index the *published* HTML under public/ (not the .org sources) so that
;; every section record carries the exact heading `id` Org emitted for THIS
;; build — those ids are content hashes that change when a heading's text
;; changes, so reading them from the same build we ship is the only way the
;; deep links (href#id) stay correct. Building from public/ also means private
;; pages are excluded for free: on the deployed build they were never written
;; there. See :completion-function on the wiki-org project below.
;;
;; Each record is {type,page,heading,href,body[,level]}:
;;   type "title"   — one per page; heading = page title; href = the page URL.
;;   type "heading" — one per <h2..h4 id>; href = page URL + "#" + heading id.
;; search.js ranks title/heading matches above fuzzy matches in `body`.

(defun wiki-html-to-text (html)
  "Strip HTML tags/entities from HTML and collapse whitespace to plain text.
Literal <,>,& only occur inside tags/entities in Org's output (real ones are
escaped), so tag-stripping does not eat prose or inline math like \\(x<y\\)."
  (let ((s (or html "")))
    (setq s (replace-regexp-in-string "<[^>]*>" " " s))
    (setq s (replace-regexp-in-string "&amp;" "&" s))
    (setq s (replace-regexp-in-string "&lt;" "<" s))
    (setq s (replace-regexp-in-string "&gt;" ">" s))
    (setq s (replace-regexp-in-string "&quot;" "\"" s))
    (setq s (replace-regexp-in-string "&#8212;" "—" s))
    (setq s (replace-regexp-in-string "&#8211;" "–" s))
    (setq s (replace-regexp-in-string "&#8217;" "’" s))
    (setq s (replace-regexp-in-string "&#[0-9]+;" " " s))
    (setq s (replace-regexp-in-string "&[a-zA-Z]+;" " " s))
    (setq s (replace-regexp-in-string "[ \t\n\r]+" " " s))
    (string-trim s)))

(defun wiki-truncate (s n)
  "Truncate string S to at most N chars, adding an ellipsis when cut."
  (if (> (length s) n) (concat (substring s 0 n) "…") s))

(defconst wiki-search-body-limit 600
  "Max characters of body text stored per search record.")

(defun wiki-region-body-text (start end &optional include-li)
  "Plain text of the <p> (and, when INCLUDE-LI, <li>) elements between START
and END in the current buffer. Skipping straight to paragraph/list content
avoids indexing the table-of-contents and other chrome."
  (let ((parts '()))
    (save-excursion
      (goto-char start)
      (while (re-search-forward "<p>\\(\\(?:.\\|\n\\)*?\\)</p>" end t)
        (push (wiki-html-to-text (match-string 1)) parts))
      (when include-li
        (goto-char start)
        (while (re-search-forward "<li>\\(\\(?:.\\|\n\\)*?\\)</li>" end t)
          (push (wiki-html-to-text (match-string 1)) parts))))
    (wiki-truncate
     (string-trim (replace-regexp-in-string
                   "[ \t\n\r]+" " " (mapconcat #'identity (nreverse parts) " ")))
     wiki-search-body-limit)))

(defun wiki-page-title-in-buffer ()
  "The page's display title from the current HTML buffer: the <h1 class=title>,
falling back to <title>."
  (save-excursion
    (goto-char (point-min))
    (cond
     ((re-search-forward "<h1 class=\"title\">\\(\\(?:.\\|\n\\)*?\\)</h1>" nil t)
      (wiki-html-to-text (match-string 1)))
     ((progn (goto-char (point-min))
             (re-search-forward "<title>\\(.*?\\)</title>" nil t))
      (wiki-html-to-text (match-string 1)))
     (t "Untitled"))))

(defun wiki-collect-search-records (href)
  "Return the list of search records for the HTML in the current buffer,
whose page URL is HREF. Assumes point-min..point-max is one published page."
  (let* ((title (wiki-page-title-in-buffer))
         (content-start (save-excursion
                          (goto-char (point-min))
                          (if (re-search-forward "<div id=\"content\"" nil t)
                              (point) (point-min))))
         (heads '())
         (records '()))
    ;; Gather every id'd heading: (tag-start tag-end level id text).
    (save-excursion
      (goto-char content-start)
      (while (re-search-forward
              "<h\\([2-4]\\) id=\"\\([^\"]+\\)\">\\(\\(?:.\\|\n\\)*?\\)</h\\1>" nil t)
        (push (list (match-beginning 0) (match-end 0)
                    (string-to-number (match-string 1))
                    (match-string 2)
                    (wiki-html-to-text (match-string 3)))
              heads)))
    (setq heads (nreverse heads))
    ;; Page-title record: intro paragraphs before the first heading (<p> only,
    ;; so the table-of-contents list is not swept in).
    (let ((intro-end (if heads (nth 0 (car heads)) (point-max))))
      (push (list (cons 'type "title") (cons 'page title) (cons 'heading title)
                  (cons 'href href)
                  (cons 'body (wiki-region-body-text content-start intro-end nil)))
            records))
    ;; One record per heading: body is everything up to the next heading.
    (let ((n (length heads)))
      (dotimes (i n)
        (let* ((h (nth i heads))
               (body-start (nth 1 h))
               (body-end (if (< (1+ i) n) (nth 0 (nth (1+ i) heads)) (point-max)))
               (level (nth 2 h))
               (hid (nth 3 h))
               (htext (nth 4 h)))
          (unless (or (string-empty-p htext)
                      (member (downcase htext)
                              '("references" "footnotes" "table of contents")))
            (push (list (cons 'type "heading") (cons 'page title)
                        (cons 'heading htext) (cons 'level level)
                        (cons 'href (concat href "#" hid))
                        (cons 'body (wiki-region-body-text body-start body-end t)))
                  records)))))
    (nreverse records)))

(defun wiki-build-search-index (_project)
  "Walk every published public/**/index.html and write public/search-index.json,
a flat array of search records consumed by static/search.js."
  (let* ((public-dir (expand-file-name "public/"))
         (files (directory-files-recursively public-dir "\\`index\\.html\\'"))
         (records '()))
    (dolist (file files)
      (let* ((rel (file-relative-name file public-dir))
             (href (concat "/" rel)))
        ;; The search page itself has no content worth indexing.
        (unless (string-prefix-p "search/" rel)
          (with-temp-buffer
            (insert-file-contents file)
            (setq records (append records (wiki-collect-search-records href)))))))
    (let ((coding-system-for-write 'utf-8))
      (with-temp-file (expand-file-name "public/search-index.json")
        (insert (json-encode (vconcat records)))))
    (message "wiki-build-search-index: wrote %d records" (length records))))

;; Build the :exclude regexp that keeps private pages' HTML and assets out of
;; the deployed build. nil (no exclusion) when building locally or when nothing
;; is private. org-publish matches :exclude against each file's path RELATIVE to
;; :base-directory (e.g. "job/index.org"), so the regexp is anchored at the
;; start with \` and ends in "/" to drop every file under content/<dir>/ (the
;; page and its whole subtree). See the "Private pages" note above.
(defvar wiki-private-exclude
  (unless wiki-include-local
    (let* ((json-array-type 'list)
           (json-object-type 'alist)
           (json-key-type 'symbol)
           (dirs (wiki-private-dirs (json-read-file "nav.json"))))
      (when dirs
        (concat "\\`\\(" (mapconcat #'regexp-quote dirs "\\|") "\\)/"))))
  "Regexp matching files under any private page's directory, or nil.")

;; ── Learn index ──────────────────────────────────────────────────────────────
;; A client-side "Learn mode" (static/learn.js) turns each page into a deck of
;; study cards: heading/body flashcards, cloze deletions built from the author's
;; /italic/ term convention, and multiple-choice questions whose distractors are
;; sampled from other cards. Since the deployed site is static, the deck is a
;; JSON file (public/learn-index.json) generated here at publish time.
;;
;; Unlike the search index, this reads the *raw .org sources*, not the published
;; HTML, and via Org's own parser (`org-element-parse-buffer`) rather than regex:
;;   • :PROPERTIES: drawers (the per-heading :LEARN_* overrides) are stripped by
;;     Org before HTML export, so they only exist in the source; and
;;   • Org's parser knows the exact emphasis borders, so /italic/ terms are found
;;     without ever misfiring inside $math$, =code=, ~verbatim~ or [[links]].
;; Because it bypasses org-publish's own :exclude, this pass must re-apply
;; `wiki-private-exclude' itself so private pages never leak into the deck.
;;
;; Each record is one quizzable heading (levels 1–3, which export to <h2>–<h4>):
;;   {id,page,pageHref,heading,level,front,back,clozeText,clozeTerms,type}
;; Overrides: a heading's :LEARN_TYPE:/:LEARN_Q:/:LEARN_A:/:LEARN_ID: drawer, a
;; :LEARN_TYPE: skip to drop one heading, or a page-level #+LEARN: nil to drop the
;; whole file. See static/learn.js for how the browser consumes these.

(defun wiki-org-href-for-file (file)
  "Map a content/ .org source path to its published page URL — the inverse of
`wiki-org-file-for-href'. E.g. content/ai/index.org -> /ai/index.html,
content/algorithms/fibonacci.org -> /algorithms/fibonacci.html."
  (let* ((rel (file-relative-name file (expand-file-name "content/")))
         (rel (replace-regexp-in-string "\\.org\\'" ".html" rel)))
    (concat "/" rel)))

(defun wiki-org-keyword (tree key)
  "Value of the first #+KEY: keyword in parsed TREE (case-insensitive), or nil."
  (org-element-map tree 'keyword
    (lambda (kw)
      (when (string= (downcase (org-element-property :key kw)) (downcase key))
        (org-element-property :value kw)))
    nil t))

(defun wiki-node-text (node)
  "Plain text of parse-tree NODE — an element, object, secondary string (a raw
list of them), or string. Emphasis markers are dropped, but LaTeX, `code' and
=verbatim= keep their literal value, so math like $w_1 + w_0$ survives intact
where a regex strip of /_*+ markers would mangle it."
  (cond
   ((null node) "")
   ((stringp node) (substring-no-properties node))
   ((consp node)
    (let ((type (org-element-type node)))
      ;; A secondary string is a bare list of objects/strings, no leading symbol.
      (if (null type)
          (mapconcat #'wiki-node-text node "")
        ;; Org stores the whitespace that follows an object in :post-blank, not
        ;; in the next node, so re-add it or adjacent words run together
        ;; ($x$ and → $x$and). Final whitespace collapse absorbs any excess.
        (concat
         (cond
          ((memq type '(code verbatim latex-fragment latex-environment))
           (or (org-element-property :value node) ""))
          ((eq type 'entity)
           (or (org-element-property :utf-8 node)
               (org-element-property :name node) ""))
          ((eq type 'line-break) " ")
          ((eq type 'link)
           (let ((contents (org-element-contents node)))
             (if contents (mapconcat #'wiki-node-text contents "")
               (or (org-element-property :raw-link node) ""))))
          (t
           ;; Paragraphs, lists, bold/italic/…: recurse into contents; separate
           ;; block-level elements so words don't run together across them.
           (concat (mapconcat #'wiki-node-text (org-element-contents node) "")
                   (if (memq type '(paragraph item table-row headline)) " " ""))))
         (make-string (or (org-element-property :post-blank node) 0) ?\s)))))
   (t "")))

(defun wiki-plain-text (data)
  "Render parse-tree DATA to readable plain text and collapse whitespace.
A raw string is parsed as an Org secondary string first, so a property value
like \":LEARN_A: /Odds/ and /likelihood ratio/.\" loses its emphasis markers."
  (let* ((nodes (if (stringp data)
                    (or (ignore-errors
                          (org-element-parse-secondary-string
                           data (org-element-restriction 'paragraph)))
                        data)
                  data)))
    (string-trim
     (replace-regexp-in-string "[ \t\n\r]+" " " (wiki-node-text nodes)))))

(defun wiki-section-body (section)
  "The prose child elements of SECTION — everything except its property drawer
and planning line — or nil. SECTION is a headline's leading `section' element."
  (when (and section (eq (org-element-type section) 'section))
    (seq-remove (lambda (el)
                  (memq (org-element-type el) '(property-drawer planning)))
                (org-element-contents section))))

(defun wiki-headline-property (headline key)
  "Value of node property KEY from HEADLINE's :PROPERTIES: drawer, or nil.
Read straight from the drawer's `node-property' nodes so it does not depend on
whether the parser folded the property onto the headline element."
  (let ((section (car (org-element-contents headline))))
    (when (eq (org-element-type section) 'section)
      (let ((drawer (seq-find (lambda (el)
                                (eq (org-element-type el) 'property-drawer))
                              (org-element-contents section))))
        (when drawer
          (org-element-map drawer 'node-property
            (lambda (np)
              (when (string= (downcase (org-element-property :key np))
                             (downcase key))
                (org-element-property :value np)))
            nil t))))))

(defun wiki-extract-cloze (body-els back)
  "Return (TERMS . TEXT) for cloze deletion, or (nil . nil).
TERMS are the /italic/ spans in BODY-ELS in document order; TEXT is BACK (the
section's clean plain text) with each term's first occurrence replaced by a
{{cN}} placeholder. A term whose text isn't found verbatim in BACK is skipped,
keeping TERMS and the {{cN}} markers exactly aligned."
  (let ((terms (org-element-map body-els 'italic
                 (lambda (it)
                   (string-trim (wiki-plain-text (org-element-contents it))))))
        (text (or back ""))
        (kept '())
        (n 0)
        (case-fold-search nil))
    (dolist (term terms)
      (let ((pos (and term (not (string-empty-p term))
                      (string-match (regexp-quote term) text))))
        (when pos
          (setq n (1+ n))
          (setq kept (append kept (list term)))
          (setq text (concat (substring text 0 pos)
                             (format "{{c%d}}" n)
                             (substring text (+ pos (length term))))))))
    (if kept (cons kept text) (cons nil nil))))

(defun wiki-stable-card-id (href heading-text)
  "A deterministic card id from page HREF + HEADING-TEXT. Stable across rebuilds
unless the URL or the exact heading text changes; a heading rename mints a new
id and orphans that one card's review history (learn.js prunes the orphan)."
  (concat "lh_" (substring (secure-hash 'sha1 (concat href "\x1f" heading-text))
                           0 12)))

(defun wiki-collect-learn-records (file href)
  "Parse .org FILE (published at HREF) and return its list of learn records, or
nil when the file opts out with #+LEARN: nil or has no quizzable headings."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((org-inhibit-startup t)
          (org-element-use-cache nil))
      (delay-mode-hooks (org-mode)))
    (let* ((tree (org-element-parse-buffer))
           (learn-kw (wiki-org-keyword tree "LEARN"))
           (page-title (or (wiki-org-keyword tree "TITLE") (file-name-base file)))
           ;; Disambiguate the id of repeated heading text on one page ("Example"
           ;; twice) so their review histories don't collide.
           (seen (make-hash-table :test 'equal))
           (records '()))
      (unless (and learn-kw (string= (downcase (string-trim learn-kw)) "nil"))
        (org-element-map tree 'headline
          (lambda (hl)
            (when (<= (org-element-property :level hl) 3)
              (let* ((htext (string-trim
                             (wiki-plain-text (org-element-property :title hl))))
                     (ltype (wiki-headline-property hl "LEARN_TYPE"))
                     (lq    (wiki-headline-property hl "LEARN_Q"))
                     (la    (wiki-headline-property hl "LEARN_A"))
                     (lid   (wiki-headline-property hl "LEARN_ID")))
                (unless (or (string-empty-p htext)
                            (member (downcase htext)
                                    '("references" "footnotes" "table of contents"))
                            (and ltype (string= (downcase (string-trim ltype)) "skip")))
                  (let* ((body-els (wiki-section-body (car (org-element-contents hl))))
                         (auto-back (string-trim (wiki-plain-text body-els)))
                         (back (if (and la (not (string-empty-p (string-trim la))))
                                   (string-trim (wiki-plain-text la))
                                 auto-back))
                         (cloze (wiki-extract-cloze body-els auto-back))
                         (front (if (and lq (not (string-empty-p (string-trim lq))))
                                    (string-trim (wiki-plain-text lq))
                                  htext))
                         (type (if (and ltype (not (string-empty-p (string-trim ltype))))
                                   (downcase (string-trim ltype))
                                 "auto"))
                         (dup (gethash htext seen 0))
                         (id-basis (if (> dup 0) (format "%s#%d" htext dup) htext))
                         (id (if (and lid (not (string-empty-p (string-trim lid))))
                                 (string-trim lid)
                               (wiki-stable-card-id href id-basis))))
                    (puthash htext (1+ dup) seen)
                    ;; Nothing to quiz if there's neither an answer nor a body.
                    (unless (string-empty-p (string-trim (or back "")))
                      (push (list (cons 'id id)
                                  (cons 'page page-title)
                                  (cons 'pageHref href)
                                  (cons 'heading htext)
                                  (cons 'level (org-element-property :level hl))
                                  (cons 'front front)
                                  (cons 'back back)
                                  (cons 'clozeText (or (cdr cloze) ""))
                                  (cons 'clozeTerms (vconcat (car cloze)))
                                  (cons 'type type))
                            records)))))))))
      (nreverse records))))

(defun wiki-build-learn-index (_project)
  "Walk every content/**/*.org (minus private pages) and write
public/learn-index.json, the flat card deck consumed by static/learn.js."
  (let* ((content-dir (expand-file-name "content/"))
         (files (directory-files-recursively content-dir "\\.org\\'"))
         (records '())
         (pages 0)
         (skipped 0))
    (dolist (file files)
      (let ((rel (file-relative-name file content-dir)))
        (unless (and wiki-private-exclude (string-match-p wiki-private-exclude rel))
          (let ((recs (wiki-collect-learn-records file (wiki-org-href-for-file file))))
            (if recs
                (progn (setq pages (1+ pages))
                       (setq records (append records recs)))
              (setq skipped (1+ skipped)))))))
    (let ((coding-system-for-write 'utf-8))
      (with-temp-file (expand-file-name "public/learn-index.json")
        (insert (json-encode (vconcat records)))))
    (message "wiki-build-learn-index: wrote %d cards across %d pages (%d pages empty/skipped)"
             (length records) pages skipped)))

(setq org-publish-project-alist
      `(("wiki-org"
         :base-directory "content/"
         :base-extension "org"
         :publishing-directory "public/"
         :recursive t
         :exclude ,wiki-private-exclude
         :publishing-function org-html-publish-to-html
         :html-head ,wiki-html-head
         :html-preamble ,wiki-preamble
         :html-postamble nil
         :html-validation-link nil
         :html-head-include-default-style nil
         :html-head-include-scripts nil
         :section-numbers nil
         :with-toc t
         :with-author t
         :with-creator nil
         :with-timestamps nil
         :completion-function (wiki-inject-toc wiki-build-search-index wiki-build-learn-index))

        ;; Images and PDFs under content/ are copied as-is
        ("wiki-assets"
         :base-directory "content/"
         :base-extension "png\\|jpg\\|jpeg\\|gif\\|svg\\|pdf\\|mp4\\|webm"
         :publishing-directory "public/"
         :recursive t
         :exclude ,wiki-private-exclude
         :publishing-function org-publish-attachment)

        ;; Stylesheet and any JS from static/ are copied as-is
        ("wiki-static"
         :base-directory "static/"
         :base-extension "css\\|js\\|ico"
         :publishing-directory "public/"
         :recursive t
         :publishing-function org-publish-attachment)

        ("wiki"
         :components ("wiki-org" "wiki-assets" "wiki-static"))))
