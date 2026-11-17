'use strict';

const { execFileSync } = require('node:child_process');

/**
 * electron-builder notarises the `.app`, and then builds the DMG *around* it and
 * leaves that alone. The app inside is therefore stapled and opens anywhere,
 * but the disk image itself carries no signature and no ticket:
 *
 *   $ xcrun stapler validate RN-Performance-Monitor-0.1.0-arm64.dmg
 *   ... does not have a ticket stapled to it.
 *   $ spctl -a -t install RN-Performance-Monitor-0.1.0-arm64.dmg
 *   source=no usable signature
 *
 * That is the artifact people actually download, so it gets the same treatment:
 * sign it, submit it, staple the ticket to it. Runs only when the credentials
 * are present, matching how electron-builder decides whether to notarise at all.
 */
module.exports = async function notarizeDmg(context) {
  const dmgs = (context.artifactPaths ?? []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return;

  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !password || !teamId) {
    console.log('  • skipped DMG notarization  reason=no Apple credentials in the environment');
    return;
  }

  // In CI the certificate lives in a throwaway keychain, so codesign has to be
  // told where to look; locally the login keychain is already the default.
  const keychain = process.env.CSC_KEYCHAIN;
  const identity = process.env.CSC_NAME;

  for (const dmg of dmgs) {
    if (identity) {
      console.log(`  • signing DMG  file=${dmg}`);
      execFileSync(
        'codesign',
        [
          '--sign', identity,
          '--timestamp',
          '--force',
          ...(keychain ? ['--keychain', keychain] : []),
          dmg,
        ],
        { stdio: 'inherit' },
      );
    }

    console.log(`  • notarizing DMG  file=${dmg}`);
    execFileSync(
      'xcrun',
      [
        'notarytool', 'submit', dmg,
        '--apple-id', appleId,
        '--password', password,
        '--team-id', teamId,
        '--wait',
      ],
      { stdio: 'inherit' },
    );

    // Stapling rewrites the DMG, which invalidates the .blockmap written beside
    // it. Nothing here uses electron-updater's deltas, so that is harmless — but
    // it is why the staple has to come last.
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  }
};
