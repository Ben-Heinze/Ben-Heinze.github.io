;;; publish.el --- Build the wiki: emacs --batch -l publish.el -f org-publish-all
;;; Serve output with: python3 -m http.server 8080 --directory public/

(require 'org)
(require 'ox-html)
(require 'json)
(require 'seq)

(org-babel-do-load-languages
 'org-babel-load-languages
 '((python      . t)
   (R           . t)
   (shell       . t)
   (emacs-lisp  . t)))

(setq org-confirm-babel-evaluate nil)
;; Use stored #+RESULTS: during export — run blocks interactively in Emacs first
(setq org-export-babel-evaluate nil)

(defvar wiki-html-head
  "<link rel=\"stylesheet\" href=\"/style.css?v=6\" />
<script>
MathJax = { tex: { inlineMath: [['\\\\(','\\\\)']], displayMath: [['\\\\[','\\\\]']] } };
</script>
<script src=\"https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js\"></script>")

;; ── Navigation ──────────────────────────────────────────────────────────
;; The nav bar is generated from nav.json (a single source of truth shared
;; with serve.py, which appends to it when a new page is created via the
;; "+ New page" dialog). Tabs are root-relative so they resolve from any
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

(defun wiki-nav-tree (items)
  "Render ITEMS (a list of nav alists) as a nested <ul>, recursing to any depth."
  (concat
   "<ul class=\"nav-tree\">\n"
   (mapconcat
    (lambda (item)
      (let ((children (alist-get 'children item)))
        (concat "<li>" (wiki-nav-link item)
                (if children (concat "\n" (wiki-nav-tree children) "\n") "")
                "</li>")))
    items "\n")
   "\n</ul>"))

(defun wiki-nav-dir (href)
  "Directory segment for HREF, e.g. \"/ai/cnns/index.html\" -> \"ai/cnns\"."
  (directory-file-name (file-name-directory (string-remove-prefix "/" href))))

(defun wiki-picker-opt (item extra-class)
  "Render one selectable row for the Location picker from nav ITEM."
  (format "<div class=\"np-opt%s\" role=\"option\" data-value=\"%s\" data-dir=\"%s\">%s</div>"
          extra-class (alist-get 'href item) (wiki-nav-dir (alist-get 'href item))
          (wiki-html-escape (alist-get 'label item))))

(defun wiki-picker-branch (items)
  "Render ITEMS as indented picker rows under a guide rail, recursing."
  (mapconcat
   (lambda (item)
     (let ((children (alist-get 'children item)))
       (concat (wiki-picker-opt item "")
               (if children
                   (concat "\n<div class=\"np-branch\">\n"
                           (wiki-picker-branch children)
                           "\n</div>")
                 ""))))
   items "\n"))

(defun wiki-picker-list (nav)
  "Render the whole Location picker: Top level plus one group per section.
Each top-level section is a visually distinct group; descendants indent under it."
  (concat
   "<div class=\"np-opt np-opt-top\" role=\"option\" data-value=\"\" data-dir=\"\">Top level</div>\n"
   (mapconcat
    (lambda (item)
      (let ((children (alist-get 'children item)))
        (concat "<div class=\"np-group\">\n"
                (wiki-picker-opt item " np-opt-top")
                (if children
                    (concat "\n<div class=\"np-branch\">\n"
                            (wiki-picker-branch children)
                            "\n</div>")
                  "")
                "\n</div>")))
    ;; Home is the site root, never a parent for new pages.
    (seq-remove (lambda (it) (string= (alist-get 'href it) "/index.html")) nav)
    "\n")))

(defun wiki-build-preamble ()
  "Build the sidebar preamble HTML from nav.json."
  (let* ((json-array-type 'list)
         (json-object-type 'alist)
         (json-key-type 'symbol)
         (nav (json-read-file "nav.json")))
    (concat
     "<a class=\"site-title\" href=\"/index.html\">yappopotamus</a>\n"
     "<button id=\"np-open\" class=\"np-open\">+ New page</button>\n"
     "<nav>\n"
     (wiki-nav-tree nav)
     "\n</nav>\n"
     ;; New-page dialog. Kept outside <nav> so the active-link script and the
     ;; nav layout ignore it; position:fixed lifts it out of the sidebar.
     "<div id=\"np-overlay\" class=\"np-overlay\" hidden>\n"
     "  <div class=\"np-dialog\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"np-heading\">\n"
     "    <h2 id=\"np-heading\" class=\"np-heading\">New page</h2>\n"
     "    <label class=\"np-label\" for=\"np-title\">Title</label>\n"
     "    <input id=\"np-title\" class=\"np-field\" type=\"text\" autocomplete=\"off\" placeholder=\"e.g. Machine Learning\">\n"
     "    <span class=\"np-label\" id=\"np-parent-label\">Location</span>\n"
     "    <div class=\"np-picker\" id=\"np-picker\">\n"
     "      <button type=\"button\" id=\"np-picker-btn\" class=\"np-field np-picker-btn\" aria-haspopup=\"listbox\" aria-expanded=\"false\" aria-labelledby=\"np-parent-label np-picker-selected\">\n"
     "        <span id=\"np-picker-selected\">Top level</span>\n"
     "        <span class=\"np-picker-caret\" aria-hidden=\"true\">&#9662;</span>\n"
     "      </button>\n"
     "      <div id=\"np-picker-list\" class=\"np-picker-list\" role=\"listbox\" tabindex=\"-1\" hidden>\n"
     (wiki-picker-list nav)
     "\n      </div>\n"
     "    </div>\n"
     "    <div class=\"np-preview\">\n"
     "      <span class=\"np-preview-eyebrow\">Creates</span>\n"
     "      <code id=\"np-preview\">/…/index.html</code>\n"
     "    </div>\n"
     "    <p id=\"np-error\" class=\"np-error\" hidden></p>\n"
     "    <div class=\"np-actions\">\n"
     "      <button id=\"np-cancel\" class=\"np-btn np-btn-ghost\" type=\"button\">Cancel</button>\n"
     "      <button id=\"np-create\" class=\"np-btn np-btn-primary\" type=\"button\">Create page</button>\n"
     "    </div>\n"
     "  </div>\n"
     "</div>\n"
     ;; Sidebar behavior lives in static/new-page.js (copied to public/ by the
     ;; wiki-static component). `defer` waits for the preamble DOM to parse.
     "<script src=\"/new-page.js?v=1\" defer></script>")))

(defvar wiki-preamble (wiki-build-preamble))

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
         :with-timestamps nil)

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
