;; Mirrors the bibliography wired up in publish.el so org-cite completion and
;; navigation (C-c C-x C-@, following a [cite:@key] link) work interactively.
((org-mode . ((eval . (setq-local org-cite-global-bibliography
                                   (list (expand-file-name "main.bib"
                                          (locate-dominating-file default-directory ".dir-locals.el"))))))))
