/* Creates the owner account from the command line, for deployments where
   reading a setup code out of the log is awkward.
   Usage: npm run owner -- owner@example.com 'a long passphrase' 'Their Name' */
import { init, close } from '../src/db.js';
import { createOwner, ownerCount } from '../src/auth.js';

const [email, password, name = 'Owner'] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: npm run owner -- <email> <password> ['Name']");
  process.exit(1);
}

init();
try {
  if (ownerCount() > 0) {
    console.error('An owner account already exists. Delete the database to start over.');
    process.exit(1);
  }
  const id = await createOwner({ email, password, name });
  console.log(`Owner account created (#${id}) for ${email}.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
} finally {
  close();
}
