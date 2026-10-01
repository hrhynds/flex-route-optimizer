/* Prints the one-time setup code, for when the line in the log has scrolled
   away. Says so plainly if setup is already done.

   Usage: npm run setup-code */
import { init, close } from '../src/db.js';
import { ensureSetupCode, ownerCount } from '../src/auth.js';

init();
try {
  if (ownerCount() > 0) {
    console.log('Setup is already complete — there is an owner account.');
    console.log('Forgotten the password? Use:  npm run reset-password -- \'a new long passphrase\'');
  } else {
    console.log('');
    console.log('  Setup code:  ' + ensureSetupCode());
    console.log('  Enter it at /admin to create your account.');
    console.log('');
  }
} finally {
  close();
}
