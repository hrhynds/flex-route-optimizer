/* Sets a new password for the owner account, for when it has been forgotten.
   Deliberately a command-line tool: it needs access to the server's own
   filesystem, which is a much better gate than an email loop for a one-person
   business. Every existing session is dropped as a side effect.

   Usage: npm run reset-password -- 'a new long passphrase' */
import { init, close, q } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { assertPasswordStrength } from '../src/auth.js';
import { audit } from '../src/db.js';

const [password] = process.argv.slice(2);

if (!password) {
  console.error("Usage: npm run reset-password -- '<new password>'");
  process.exit(1);
}

init();
try {
  const owner = q.get('SELECT id, email FROM owners ORDER BY id LIMIT 1');
  if (!owner) {
    console.error('There is no owner account yet. Use `npm run owner` to create one.');
    process.exit(1);
  }
  assertPasswordStrength(password);
  const hash = await hashPassword(password);
  q.run('UPDATE owners SET pass_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?', hash, owner.id);
  const dropped = q.run('DELETE FROM sessions WHERE owner_id = ?', owner.id).changes;
  audit('cli', 'owner.password_reset', 'owner', owner.id);
  console.log(`Password reset for ${owner.email}. ${dropped} signed-in session${dropped === 1 ? '' : 's'} ended.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
} finally {
  close();
}
