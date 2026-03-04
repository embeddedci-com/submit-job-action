# EmbeddedCI Submit Job

GitHub Action that submits an `embeddedci.yaml` job definition from your repository to the EmbeddedCI server.

## Usage

Ensure your workflow checks out the repository first so `embeddedci.yaml` is available:

```yaml
jobs:
  submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: embeddedci/submit-job-action@v1
        with:
          api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | - | API key for EmbeddedCI. Use `secrets.EMBEDDEDCI_API_KEY`. |
| `server` | No | `https://api.embeddedci.com` | EmbeddedCI server base URL. Override for self-hosted or staging. |
| `definition_file` | No | `embeddedci.yaml` | Path to the job definition YAML file in the repo. |
| `name` | No | - | Optional job name. |
| `ref` | No | - | Optional ref (e.g. branch or tag). |

## Examples

### Custom definition file and server

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    server: https://ci.mycompany.com
    definition_file: .embeddedci/job.yaml
```

### With job name and ref

```yaml
- uses: embeddedci/submit-job-action@v1
  with:
    api_key: ${{ secrets.EMBEDDEDCI_API_KEY }}
    name: ${{ github.repository }} build
    ref: ${{ github.ref_name }}
```

## Outputs

| Output | Description |
|--------|-------------|
| `job_id` | Set when the server returns a job id in the response. |

## Development

```bash
npm install
npm run build
```

The built action is in `dist/`. Commit `dist/` so the action works when used from GitHub.
