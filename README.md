# EmbeddedCI Submit Job

GitHub Action that submits jobs to the EmbeddedCI server in two modes:
- YAML-only mode: send pipeline definition text.
- Archive mode: send source bundle + `embeddedci_yaml` using multipart upload.

## Usage

Ensure your workflow checks out the repository first.

How the modes differ:

- **Archive mode** archives the contents of `source_path` and sends that archive to the server (with `embeddedci_yaml` for which pipeline file to use inside the bundle).
- **YAML-only mode** sends nothing except the pipeline YAML. Use it when source files are publicly accessible via Git (or similar) as specified inside the YAML, so the server can fetch them without an upload from this action.

### Archive mode (recommended for repo-based builds)

```yaml
jobs:
  submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: embeddedci/submit-job-action@v1
        with:
          api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
          source_path: .
```


### YAML-only mode

```yaml
jobs:
  submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: embeddedci/submit-job-action@v1
        with:
          api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
          embeddedci_yaml: embeddedci.yaml
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | - | API key for EmbeddedCI. Use `secrets.EMBEDDEDCI_API_KEY`. |
| `api_url` | No | `https://api.embeddedci.com` | EmbeddedCI server base URL. Override for self-hosted or staging. |
| `source_path` | No | empty | Path to what should be uploaded in archive mode. You can pass a directory (including `.`) and the action creates the archive automatically, or pass an existing archive file (`.tar.gz`, `.tgz`, `.tar`, `.zip`). |
| `embeddedci_yaml` | No | empty | Pipeline YAML path. In YAML-only mode this is the repo file path (defaults to `embeddedci.yaml` when omitted). In archive mode this optionally overrides auto-detection (`embeddedci.yaml`). |
| `ref` | No | branch name from GitHub context | Ref associated with the submission. Auto-detected from `GITHUB_HEAD_REF` (PRs) or `GITHUB_REF_NAME`. |
| `commit` | No | `GITHUB_SHA` | Commit SHA associated with the submission. |

## Examples

### Custom pipeline file and API URL (YAML-only)

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    api_url: https://ci.mycompany.com
    embeddedci_yaml: .embeddedci/job.yaml
```

### Archive from current directory on-the-fly

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    source_path: .
```

### Archive from a specific directory on-the-fly

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    source_path: firmware/
```

### Override pipeline path inside archive (optional)

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    source_path: firmware/
    embeddedci_yaml: ci/embeddedci.yaml
```

### Explicit ref and commit metadata (optional)

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    source_path: .
    ref: ${{ github.ref_name }}
    commit: ${{ github.sha }}
```

### Use a prebuilt archive file (optional)

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    source_path: repo.tar.gz
```

## Outputs

| Output | Description |
|--------|-------------|
| `job_id` | Set when the server returns a job id in the response. |
| `job_status` | Set when the server returns a job status. |
| `job_builds` | JSON-encoded builds payload when present. |
| `source_metadata` | JSON-encoded source metadata when present. |

## Archive Preparation Recommendations

- Prefer passing a directory path (for example `.`) and let the action archive it automatically.
- Exclude large/unneeded files such as `.git`, build outputs, and caches when creating archives manually.
- Include `embeddedci.yaml` in the archive root when using default auto-detection.
- Set `embeddedci_yaml` when your pipeline file lives at a custom archive path.

## Development

```bash
npm install
npm run build
```

The built action is in `dist/`. Commit `dist/` so the action works when used from GitHub.


## Actions in this repository

| Action | Use it for |
|---|---|
| `embeddedci-com/embeddedci-github-action@main` | Submit a pipeline or source archive to the EmbeddedCI build system. |
| `embeddedci-com/embeddedci-github-action/upload-artifact@main` | Publish a firmware you built yourself, so it appears in the BenchPod flash dropdown. |

### `upload-artifact`

Records a build you produced in your own workflow as a **GitHub-sourced build** on
embeddedci.com and attaches the firmware to it. No BenchPod is touched, so it is safe to run
on every push.

```yaml
permissions:
  id-token: write        # required: the action authenticates with the job's OIDC token
  contents: read

steps:
  - uses: actions/checkout@v5
  # ... your existing build ...
  - uses: embeddedci-com/embeddedci-github-action/upload-artifact@main
    with:
      firmware: build/app.elf
      build_target: stm32f4
      openocd_target: target/stm32f4x.cfg
      swclk: "11"
      swdio: "12"
      efuse: "1"
```

The firmware's siblings (`.elf` / `.bin` / `.hex` / `.uf2` with the same stem) are uploaded
alongside it, and the wiring inputs pre-fill the web UI's flash dialog. The repository must be
trusted in the EmbeddedCI web app under **BenchPod → GitHub Actions**; without that, or without
`id-token: write`, the step fails with a message naming what is missing.

Set `allow_missing_token: "true"` to downgrade that failure to a skip — useful for pull requests
from forks, which cannot mint an OIDC token.

Outputs `build_id`.

Implementation note: this is a composite action wrapping `python -m embeddedci.upload_build` from
the [embeddedci Python SDK](https://github.com/embeddedci-com/embeddedci-python), which is the same
code path the pytest `build_report` fixture uses. Keeping one implementation avoids a second copy of
the OIDC exchange and build API drifting from the server.
