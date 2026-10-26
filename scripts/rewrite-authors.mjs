/**
 * Rewrites commit authorship so GitHub links the commits to the real account.
 *
 * The repository was created without a `git` binary, so commits were authored as
 * "Model Intelligence Lab <noreply@example.invalid>". GitHub cannot associate
 * that with any profile, so the public repo shows no contributor. This rewrites
 * each commit in place — same tree, same message, same parent chain — with the
 * account's GitHub noreply address, which GitHub does resolve.
 *
 * Usage: node scripts/rewrite-authors.mjs [--dry-run]
 */
import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

// Verified earlier in this session: GET /user returned login "iiiiiiiiiiiiiKK",
// id 132676579. The noreply form below is the one GitHub links to the account.
const AUTHOR = {
  name: 'KK-Trade',
  email: '132676579+iiiiiiiiiiiiiKK@users.noreply.github.com',
};

const branch = await git.currentBranch({ fs, dir: root, fullname: false });
if (!branch) {
  console.error('Not on a branch; refusing to rewrite.');
  process.exit(1);
}

const tip = await git.resolveRef({ fs, dir: root, ref: `refs/heads/${branch}` });
const commits = await git.log({ fs, dir: root, ref: tip }); // newest first
const chronological = [...commits].reverse();

console.log(`branch ${branch}: ${commits.length} commit(s)`);
for (const entry of commits) {
  console.log(
    `  ${entry.oid.slice(0, 8)}  ${entry.commit.author.name} <${entry.commit.author.email}>  ${entry.commit.author.timestamp >= 0 ? '' : ''}`,
  );
}

if (dryRun) {
  console.log('\nDry run: no rewrite written.');
  process.exit(0);
}

let parentOid = null;
const mapping = [];

for (const entry of chronological) {
  const { commit } = entry;
  // isomorphic-git returns the new oid as a plain string here.
  const oid = await git.writeCommit({
    fs,
    dir: root,
    commit: {
      tree: commit.tree,
      parent: parentOid ? [parentOid] : [],
      message: commit.message,
      author: {
        name: AUTHOR.name,
        email: AUTHOR.email,
        // Preserve the original timestamps so history stays honest.
        timestamp: commit.author.timestamp,
        timezoneOffset: commit.author.timezoneOffset,
      },
      committer: {
        name: AUTHOR.name,
        email: AUTHOR.email,
        timestamp: commit.committer.timestamp,
        timezoneOffset: commit.committer.timezoneOffset,
      },
    },
  });
  mapping.push({ from: entry.oid, to: oid });
  parentOid = oid;
  console.log(`rewrote ${entry.oid.slice(0, 8)} -> ${oid.slice(0, 8)}`);
}

await git.writeRef({
  fs,
  dir: root,
  ref: `refs/heads/${branch}`,
  value: parentOid,
  force: true,
});

console.log(`\n${branch} now points at ${parentOid.slice(0, 8)}`);
console.log('Authors are now:');
for (const entry of await git.log({ fs, dir: root, ref: parentOid })) {
  console.log(`  ${entry.oid.slice(0, 8)}  ${entry.commit.author.name} <${entry.commit.author.email}>`);
}
