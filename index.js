import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';

async function main() {
  try {
    const apiKey = core.getInput('api_key', { required: true });
    const server = core.getInput('server') || 'https://api.embeddedci.com';
    const definitionFile = core.getInput('definition_file') || 'embeddedci.yaml';
    const name = core.getInput('name') || undefined;
    const ref = core.getInput('ref') || undefined;

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const definitionPath = path.resolve(workspace, definitionFile);

    if (!fs.existsSync(definitionPath)) {
      core.setFailed(`Definition file not found: ${definitionPath}`);
      return;
    }

    const definition = fs.readFileSync(definitionPath, 'utf8');

    const body = { definition };
    if (name) body.name = name;
    if (ref) body.ref = ref;

    const baseUrl = server.replace(/\/$/, '');
    const url = `${baseUrl}/api/jobs/submit`;

    core.info(`Submitting job to ${url}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      core.setFailed(`Submit failed (${response.status}): ${text}`);
      return;
    }

    const result = await response.json().catch(() => ({}));
    core.info('Job submitted successfully.');
    if (result.id) core.setOutput('job_id', result.id);
  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
