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

;; The inline theme script runs before the body paints so the stored (or
;; system-preferred) light/dark theme is applied with no flash of the wrong
;; palette. It only sets the data-theme attribute the CSS keys off of; the
;; toggle button's click handler lives in new-page.js.
(defvar wiki-html-head
  "<link rel=\"stylesheet\" href=\"/style.css?v=11\" />
<script>(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>")

;; ── Navigation ──────────────────────────────────────────────────────────
;; The nav bar is generated from nav.json (a single source of truth shared
;; with serve.py, which appends to it when a new page is created via
;; `just new-page`). Tabs are root-relative so they resolve from any
;; subdirectory.

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
                   "<span class=\"nav-toggle-spacer\" aria-hidden=\"true\"></span>")))
    (concat "<li>"
            "<div class=\"nav-row\">" toggle (wiki-nav-link item) "</div>"
            (if children (concat "\n" (wiki-nav-tree children) "\n") "")
            "</li>")))

(defun wiki-nav-tree (items)
  "Render ITEMS (a list of nav alists) as a nested <ul>, recursing to any depth."
  (concat
   "<ul class=\"nav-tree\">\n"
   (mapconcat #'wiki-nav-item items "\n")
   "\n</ul>"))

(defun wiki-nav-less (a b)
  "Ordering predicate for two nav items: alphabetical by label (case-insensitive).
The Home entry (href \"/index.html\") always sorts first."
  (let ((ha (alist-get 'href a)) (hb (alist-get 'href b)))
    (cond ((string= ha "/index.html") t)
          ((string= hb "/index.html") nil)
          (t (string-lessp (downcase (or (alist-get 'label a) ""))
                           (downcase (or (alist-get 'label b) "")))))))

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
         (nav (wiki-nav-sort (json-read-file "nav.json"))))
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
     "<script src=\"/new-page.js?v=5\" defer></script>")))

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
         (nav (wiki-nav-sort (json-read-file "nav.json")))
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

(setq org-publish-project-alist
      `(("wiki-org"
         :base-directory "content/"
         :base-extension "org"
         :publishing-directory "public/"
         :recursive t
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
         :completion-function (wiki-inject-toc))

        ;; Images and PDFs under content/ are copied as-is
        ("wiki-assets"
         :base-directory "content/"
         :base-extension "png\\|jpg\\|jpeg\\|gif\\|svg\\|pdf\\|mp4\\|webm"
         :publishing-directory "public/"
         :recursive t
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
