{
  description = "Personal wiki built with Org mode";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.systems.url = "github:nix-systems/default";
  inputs.flake-utils = {
    url = "github:numtide/flake-utils";
    inputs.systems.follows = "systems";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        emacs = pkgs.emacsPackages.emacsWithPackages (epkgs: with epkgs; [
          htmlize  # syntax highlighting in exported HTML code blocks
          ess      # R session support for org-babel :session blocks
        ]);
        python = pkgs.python3.withPackages (ps: with ps; [
          pandas
          numpy
          matplotlib
          scipy
          networkx
        ]);
        R = pkgs.rWrapper.override {
          packages = with pkgs.rPackages; [
            tidyverse
            Sleuth3
            arm       # binnedplot, bayesglm, ilogit
            dispmod   # orobanche dataset
            effects   # allEffects plots
            car       # crPlots, some
          ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            emacs
            python
            R
            pkgs.just
            pkgs.xdg-utils
          ];
        };
      }
    );
}
