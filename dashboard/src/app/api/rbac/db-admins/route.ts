import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function resolveByWalkingUp(relativePath: string, maxLevels = 8) {
  const fs = require('fs');
  const path = require('path');
  const attempted: string[] = [];
  let base = process.cwd();

  for (let i = 0; i <= maxLevels; i += 1) {
    const candidate = path.resolve(base, relativePath);
    attempted.push(candidate);
    if (fs.existsSync(candidate)) {
      return { path: candidate, attempted };
    }
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }

  return { path: attempted[0], attempted };
}

async function queryTenantAdmins(tenantApp: 'nexabank' | 'safexbank'): Promise<string[]> {
  const scriptResolution = resolveByWalkingUp('scripts/nexbank_user_lookup.py');
  const scriptPath = scriptResolution.path;

  const fs = require('fs');
  if (!fs.existsSync(scriptPath)) {
    console.log(`[DB-ADMINS] Script not found: ${scriptPath}`);
    return [];
  }

  const workspaceRoot = require('path').dirname(require('path').dirname(scriptPath));
  const relativeScriptPath = require('path').relative(workspaceRoot, scriptPath);

  const isWin = process.platform === 'win32';
  const candidates: Array<{ cmd: string; args: string[] }> = isWin
    ? [
        { cmd: 'py', args: ['-3', relativeScriptPath, '--list-admins', tenantApp] },
        { cmd: 'python', args: [relativeScriptPath, '--list-admins', tenantApp] },
      ]
    : [
        { cmd: 'python3', args: [relativeScriptPath, '--list-admins', tenantApp] },
        { cmd: 'python', args: [relativeScriptPath, '--list-admins', tenantApp] },
      ];

  for (const candidate of candidates) {
    try {
      console.log(`[DB-ADMINS] Querying ${tenantApp} with: ${candidate.cmd} ${candidate.args.join(' ')}`);
      const { stdout } = await execFileAsync(candidate.cmd, candidate.args, {
        timeout: 30000,
        windowsHide: true,
        cwd: workspaceRoot,
      });

      const parsed = JSON.parse(String(stdout || '{}')) as { admins?: string[] };
      if (parsed.admins && Array.isArray(parsed.admins)) {
        console.log(`[DB-ADMINS] Found ${parsed.admins.length} admins in ${tenantApp}: ${parsed.admins.join(', ')}`);
        return parsed.admins;
      }
    } catch (err) {
      const errMsg = (err as Error)?.message || String(err);
      console.log(`[DB-ADMINS] Failed to query ${tenantApp} with ${candidate.cmd}: ${errMsg}`);
    }
  }

  return [];
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.user || session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [nexabankAdmins, safexbankAdmins] = await Promise.all([
      queryTenantAdmins('nexabank'),
      queryTenantAdmins('safexbank'),
    ]);

    return NextResponse.json({
      nexabank: nexabankAdmins,
      safexbank: safexbankAdmins,
    });
  } catch (error: any) {
    console.error('[DB-ADMINS] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
