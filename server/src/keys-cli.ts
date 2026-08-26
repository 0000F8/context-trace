/**
 * `npm run keys -w context-trace-server -- <command> [...args]`
 *
 * Self-host key management without a running server (spec3.md §C). Operates directly
 * on the SQLite file at CT_DB (same default as index.ts), via the same store.ts
 * functions the admin HTTP routes use.
 */
import { openDb } from './db.js';
import * as store from './store.js';

const dbPath = process.env.CT_DB ?? './data/context-trace.db';

function usage(): never {
  console.error(
    [
      'Usage: keys <command> [...args]',
      '',
      'Commands:',
      '  list-projects',
      '  create-project <name>',
      '  create-key <projectId> <name> <read|write|admin>',
      '  list-keys <projectId>',
      '  revoke-key <keyId>',
    ].join('\n')
  );
  process.exit(1);
}

function fmtDate(iso: string | undefined): string {
  return iso ?? '-';
}

/** Positional usage line per command — the single source of truth for both `usage()` and flag rejection. */
function usageLineFor(command: string): string | undefined {
  switch (command) {
    case 'list-projects':
      return 'keys list-projects';
    case 'create-project':
      return 'keys create-project <name>';
    case 'create-key':
      return 'keys create-key <projectId> <name> <read|write|admin>';
    case 'list-keys':
      return 'keys list-keys <projectId>';
    case 'revoke-key':
      return 'keys revoke-key <keyId>';
    default:
      return undefined;
  }
}

/**
 * This CLI is positional-only (matches `deploy/single-tenant/provision.sh`'s calling
 * convention) — it never parses `--flags`. Without this guard, a self-hoster who guesses
 * flag syntax (`create-project --name ProjA`) gets a project literally named "--name" with
 * no error, silently dropping "ProjA". Reject anything flag-shaped before it can be used
 * as a value — and before the DB is even opened, so a bad invocation touches nothing.
 */
function rejectFlagArgs(args: string[], usageLine: string): void {
  const flag = args.find((a) => a.startsWith('-'));
  if (flag !== undefined) {
    console.error(`unrecognized option "${flag}" — this CLI takes positional arguments: ${usageLine}`);
    process.exit(1);
  }
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  // Validate before touching the DB at all: an unknown command falls through to the
  // switch's own `default: usage()` below, but a known command with a flag-shaped
  // argument is rejected here, before `openDb` ever runs.
  const usageLine = usageLineFor(command);
  if (usageLine) rejectFlagArgs(args, usageLine);

  const db = openDb(dbPath);

  switch (command) {
    case 'list-projects': {
      const projects = store.listProjects(db);
      if (projects.length === 0) {
        console.log('(no projects)');
        break;
      }
      console.log('id'.padEnd(24) + 'name'.padEnd(24) + 'createdAt');
      for (const p of projects) {
        console.log(p.id.padEnd(24) + p.name.padEnd(24) + p.createdAt);
      }
      break;
    }

    case 'create-project': {
      const [name] = args;
      if (!name) usage();
      const project = store.createProject(db, name);
      console.log(`created project ${project.id} (${project.name}) at ${project.createdAt}`);
      break;
    }

    case 'create-key': {
      const [projectId, name, role] = args;
      if (!projectId || !name || !role) usage();
      if (role !== 'read' && role !== 'write' && role !== 'admin') {
        console.error('role must be one of: read, write, admin');
        process.exit(1);
      }
      // createProjectKey checks the project exists before writing anything — a bad
      // projectId here fails cleanly rather than leaving an orphaned key row.
      const created = store.createProjectKey(db, projectId, name, role);
      if (!created) {
        console.error(`no such project: ${projectId}`);
        process.exit(1);
      }
      console.log('created key — store this now, it is shown exactly once:');
      console.log('');
      console.log(`  ${created.key}`);
      console.log('');
      console.log(`  id:      ${created.id}`);
      console.log(`  project: ${created.projectId}`);
      console.log(`  role:    ${created.role}`);
      console.log(`  prefix:  ${created.prefix}`);
      break;
    }

    case 'list-keys': {
      const [projectId] = args;
      if (!projectId) usage();
      const keys = store.listProjectKeys(db, projectId);
      if (keys.length === 0) {
        console.log('(no keys)');
        break;
      }
      console.log(
        'id'.padEnd(24) + 'name'.padEnd(20) + 'role'.padEnd(8) + 'prefix'.padEnd(14) + 'lastUsedAt'.padEnd(24) + 'revokedAt'
      );
      for (const k of keys) {
        console.log(
          k.id.padEnd(24) +
            k.name.padEnd(20) +
            k.role.padEnd(8) +
            k.prefix.padEnd(14) +
            fmtDate(k.lastUsedAt).padEnd(24) +
            fmtDate(k.revokedAt)
        );
      }
      break;
    }

    case 'revoke-key': {
      const [keyId] = args;
      if (!keyId) usage();
      const revoked = store.revokeProjectKey(db, keyId);
      if (!revoked) {
        console.error(`no such active key: ${keyId}`);
        process.exit(1);
      }
      console.log(`revoked key ${keyId}`);
      break;
    }

    default:
      usage();
  }

  db.close();
}

main();
