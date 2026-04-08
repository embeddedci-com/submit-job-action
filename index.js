import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const SUPPORTED_ARCHIVE_EXTENSIONS = [
  '.tar.gz',
  '.tgz',
  '.tar',
  '.zip',
];

function hasSupportedArchiveExtension(filePath) {
  const lower = filePath.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function normalizeEmbeddedciYamlPath(embeddedciYamlPath) {
  return embeddedciYamlPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function listArchiveEntries(archivePath) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    return execFileSync('unzip', ['-Z', '-1', archivePath], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  return execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveEmbeddedciYamlPath(archiveEntries, embeddedciYamlOverride) {
  const normalizedEntries = archiveEntries.map(normalizeEmbeddedciYamlPath);

  if (embeddedciYamlOverride) {
    const override = normalizeEmbeddedciYamlPath(embeddedciYamlOverride);
    if (!normalizedEntries.includes(override)) {
      throw new Error(`Pipeline file "${override}" was not found in the archive.`);
    }
    return override;
  }

  const autoCandidates = ['embeddedci.yaml'];
  for (const candidate of autoCandidates) {
    if (normalizedEntries.includes(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'No pipeline file found in archive. Expected "embeddedci.yaml", or set "embeddedci_yaml" explicitly.',
  );
}

function createArchiveFromDirectory(directoryPath) {
  const archivePath = path.join(
    os.tmpdir(),
    `embeddedci-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
  );

  // Keep archive creation simple and predictable for runners with BSD/GNU tar.
  execFileSync(
    'tar',
    ['-czf', archivePath, '.'],
    { cwd: directoryPath, stdio: 'pipe' },
  );

  return archivePath;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function applyCommonOutputs(result) {
  if (result.id) core.setOutput('job_id', result.id);
  if (result.status) core.setOutput('job_status', result.status);
  if (typeof result.builds !== 'undefined') {
    core.setOutput('job_builds', JSON.stringify(result.builds));
  }
  if (result.source_metadata) {
    core.setOutput('source_metadata', JSON.stringify(result.source_metadata));
  }
}

function failWithHttpError(response, result) {
  const serverMessage =
    typeof result.error === 'string'
      ? result.error
      : typeof result.message === 'string'
        ? result.message
        : typeof result._raw === 'string'
          ? result._raw
          : JSON.stringify(result);
  core.setFailed(`Submit failed (${response.status}): ${serverMessage}`);
}

function normalizeApiUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'https://api.embeddedci.com';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function main() {
  try {
    const apiKey = core.getInput('api_key', { required: true });
    const apiUrl = normalizeApiUrl(core.getInput('api_url'));
    const embeddedciYamlInput = core.getInput('embeddedci_yaml') || 'embeddedci.yaml';
    const sourcePathInput = core.getInput('source_path');
    const refInput = core.getInput('ref');
    const commitInput = core.getInput('commit');
    const ref = refInput || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '';
    const commit = commitInput || process.env.GITHUB_SHA || '';

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const baseUrl = apiUrl.replace(/\/$/, '');
    const url = `${baseUrl}/api/jobs/submit`;
    const authHeader = { Authorization: `ApiKey ${apiKey}` };

    // Dual-mode behavior: archive mode when source_path is set, otherwise YAML-only JSON mode.
    if (sourcePathInput) {
      const sourcePath = path.resolve(workspace, sourcePathInput);
      if (!fs.existsSync(sourcePath)) {
        core.setFailed(`Archive source not found: ${sourcePath}`);
        return;
      }

      const stat = fs.statSync(sourcePath);
      let archivePath = sourcePath;
      let archiveWasGenerated = false;

      try {
        if (stat.isDirectory()) {
          core.info(`Creating archive from directory: ${sourcePath}`);
          archivePath = createArchiveFromDirectory(sourcePath);
          archiveWasGenerated = true;
        } else if (!stat.isFile()) {
          core.setFailed(`Archive source must be a file or directory: ${sourcePath}`);
          return;
        }

        if (!hasSupportedArchiveExtension(archivePath)) {
          core.setFailed(
            `Invalid archive extension for "${archivePath}". Supported: ${SUPPORTED_ARCHIVE_EXTENSIONS.join(', ')}`,
          );
          return;
        }

        const archiveEntries = listArchiveEntries(archivePath);
        const embeddedciYaml = resolveEmbeddedciYamlPath(archiveEntries, core.getInput('embeddedci_yaml'));
        core.info(`Using archive pipeline file: ${embeddedciYaml}`);

          core.info(`Submitting archive job to ${url}...`);
          const formData = new FormData();
          formData.append('archive', new Blob([fs.readFileSync(archivePath)]), path.basename(archivePath));
          formData.append('embeddedci_yaml', embeddedciYaml);
          if (ref) formData.append('ref', ref);
          if (commit) formData.append('commit', commit);

          const response = await fetch(url, {
            method: 'POST',
            headers: authHeader,
            body: formData,
          });

          const result = await readJsonSafe(response);
          if (!response.ok) {
            if (response.status === 503) {
              core.error('Server reported archive storage as unavailable (503).');
            }
            failWithHttpError(response, result);
            return;
          }

          core.info('Archive job submitted successfully.');
          applyCommonOutputs(result);
          return;
        } catch (error) {
          core.setFailed(`Archive submit failed: ${error.message}`);
          return;
        } finally {
          if (archiveWasGenerated && fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
          }
        }
    }

    const definitionPath = path.resolve(workspace, embeddedciYamlInput);
    if (!fs.existsSync(definitionPath)) {
      core.setFailed(`Pipeline file not found: ${definitionPath}`);
      return;
    }

    const definition = fs.readFileSync(definitionPath, 'utf8');
    const body = { definition };
    if (ref) body.ref = ref;
    if (commit) body.commit = commit;

    core.info(`Submitting YAML job to ${url}...`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const result = await readJsonSafe(response);
    if (!response.ok) {
      failWithHttpError(response, result);
      return;
    }

    core.info('YAML job submitted successfully.');
    applyCommonOutputs(result);
  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
