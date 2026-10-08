# Contributing

Thanks for helping out. Issues and pull requests are welcome.

## Before you open a pull request

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- The Node action runs from the committed bundle. After changing `index.js` or a dependency:

  ```bash
  npm ci
  npm run build   # writes dist/; commit it with your change
  ```

- The composite actions (`upload-artifact/`, `emi/`) pass every input to bash through `env:` and
  quote it there. Keep it that way: an input expression inside `run:` can run shell code.
- Pin any action you add by its full commit SHA, with the version in a comment.
- Try the change from a workflow in a test repository (`uses: <your fork>@<branch>`) and say how in
  the pull request.

## Releases

Maintainers tag `vX.Y.Z` and move the `v1` tag to it.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
