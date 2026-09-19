import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../../..');
const desktopSource = fs.readFileSync(path.join(repoRoot, 'desktop/main.cjs'), 'utf8');
const serverSource = fs.readFileSync(path.join(repoRoot, 'backend/server.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) {
    throw new Error(`function ${name} not found`);
  }
  return match[0];
}

function envNullishDefault(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`process\\.env\\.${name}\\s*\\?\\?=\\s*['"]([^'"]+)['"]`));
  return match?.[1];
}

function extractChromeLaunchArgs(source: string): string {
  const match = source.match(/spawn\(executable,\s*\[([\s\S]*?)\],\s*\{\s*detached:\s*true/);
  if (!match) {
    throw new Error('Chrome spawn(executable, [...]) args not found');
  }
  return match[1];
}

describe('desktop CDP default launch contract', () => {
  it('defaults NOVA_CDP_LAUNCH_ENABLED to true whenever desktop CDP is on by default', () => {
    const prepareBackendEnv = extractFunction(desktopSource, 'prepareBackendEnv');
    const cdpEnabledDefault = envNullishDefault(prepareBackendEnv, 'NOVA_CDP_ENABLED');
    const launchEnabledDefault = envNullishDefault(prepareBackendEnv, 'NOVA_CDP_LAUNCH_ENABLED');

    expect(cdpEnabledDefault).toBe('true');
    expect(launchEnabledDefault).toBe('true');
  });

  it('binds launched Chrome remote debugging to loopback 127.0.0.1', () => {
    const launchArgs = extractChromeLaunchArgs(serverSource);
    expect(launchArgs).toContain('--remote-debugging-address=127.0.0.1');
    expect(launchArgs).not.toContain('--remote-debugging-address=0.0.0.0');
  });
});
