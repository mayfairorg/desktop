'use strict';
// Mayfair Ghost Terms: the text shown on the Terms screen. The version and the SHA-256 of the exact text are what the app records when a person accepts,
// so changing a word changes the hash, and a new major version asks again. [[double brackets]] are gaps for the owner's lawyer; the screen says so.
// Copyright The Mayfair Organization.
const crypto = require('node:crypto');

const VERSION = '1.0';
const CLAUSES = [
  { title: `1. What Mayfair Ghost is`, body: `Mayfair Ghost ("Ghost") is an optional app for Mayfair Desktop, made by [[legal name of The Mayfair Organization]] ("Mayfair", "we"). It helps you look up public information about domains, networks, companies, documents, places and events, keep what you find in a case on your own computer, and write a report that lists every source.

Ghost is free. We do not limit how much you use it. The public services it talks to have their own fair-use rules, and Ghost follows them, so some lookups are slowed down on purpose.

Ghost works with open-source tools made by other people. They are not installed with Mayfair Desktop. They are downloaded only when you choose to use a tool, and each one shows its own licence first.` },
  { title: `2. Who may use it, and why`, body: `Ghost is for approved professional users: people who work for a government body, or who hold a professional licence or registration, and who have a genuine, lawful reason to look up public information. Access is tied to your Mayfair ID and is approved by Mayfair. Without approval Ghost does not open. Approval can expire and can be withdrawn.

Examples of genuine reasons: security testing of systems you own or are allowed to test; checking what is exposed about your own organisation; journalism and research; due diligence and compliance checks on organisations; fraud, abuse and trust-and-safety work; brand and trademark protection; threat intelligence; legal and investigative work within the law; teaching, study and training exercises.

You must be at least [[minimum age]] and able to enter a contract. If you use Ghost for an organisation, you confirm you have the right to bind it. You are responsible for knowing the laws that apply to you and to what you do with Ghost, including laws on computer misuse, data protection, privacy, harassment, surveillance and publishing.

Mayfair records your access at account level (that you applied, were approved, or had approval withdrawn). Mayfair does not see your cases, lookups or scans: they stay in your encrypted vault on your computer.` },
  { title: `3. What you must not do`, body: `You must not use Ghost, or what you collect with it, to:

- stalk, harass, threaten, intimidate, expose or locate a private person, or to find a person's home address, accounts, relatives or movements;
- build a profile of an individual;
- get into any system, account or data without permission, or get around a login, paywall, CAPTCHA, rate limit or other access control;
- scan, probe or test any system you do not own and do not have clear written permission to test;
- attack, overload, break, damage or take over any system, or to take part in fraud, extortion, blackmail or discrimination;
- break the rules of the public services Ghost connects to, or hide who you are from them in a way their rules forbid;
- remove or hide notices, attributions or licences, or to pass off public data as something it is not.

Ghost does not include tools for finding people's accounts, people-search, looking up individuals in breach data, or face matching. Do not try to add or use such tools with it.` },
  { title: `4. Active scanning of your own or authorised systems`, body: `Some tools in Ghost send traffic to a target to see what is there (for example port and service discovery or a web check). These are "active" tools. Passive lookups ask public sources; active tools talk to the target itself. Active tools may also be switched off for your account.

Before an active scan Ghost asks you to name the target, say whether you own it or have written permission, and confirm that. By doing so you promise that the statement is true and that you may lawfully scan that target.

If you say you have permission, you must have it in writing from a person who has the right to give it, and you must keep it. Ghost writes each scan (the time, target, the basis you gave, the tool and its settings) to the log in your vault on your computer. The log is yours. We do not receive it. It is a record to help you, and it is not proof that a scan was lawful.

Ghost limits scans to the target you named, to ranges of no more than 256 addresses at a time, and to checks that read information. These limits reduce risk. They do not make a scan lawful. Scanning a system without permission can be a crime. You are solely responsible for every scan you start.` },
  { title: `5. Public sources, other people's information and data protection`, body: `Public does not mean free of rules. Information found in public records, registers, certificates, archives and news can include personal data. Where it does, you decide why and how you collect it, so you are responsible for having a lawful reason, collecting only what you need, keeping it only as long as you need it, keeping it secure, and deleting it when you are done.

Ghost is built to help: it works with organisations, networks, documents, places and events, it records where each item, and each field you add, came from and when, and it lets you delete anything from a case, hide anything from a report and delete a whole case.

[[Draft wording for lawyer review before release.]] You are responsible for using Ghost lawfully. Ghost lets you record any details you choose, including personal data about real people such as a name, a job title, a profile link or a contact detail, and it does not check or limit what you enter. If you record personal data, you decide why and how, so you are responsible for your own data-protection duties under the UK GDPR and the EU GDPR, for example having a lawful basis, keeping only what you need, keeping it accurate and secure, deleting it when you no longer need it, and answering the people it is about when they ask. Mayfair does not see your cases and is not responsible for the personal data you record or what you do with it.

Information from public sources can be wrong, out of date or incomplete. Check anything important before you rely on it or act on it, and before you say it about anyone.` },
  { title: `6. Open-source tools and public services made by others`, body: `Ghost uses open-source programs and public data services that are not ours. Each program has its own licence, shown on its page in the App Library before you install it and listed in the third-party notices in the app. Where a licence gives you more rights than these Terms, those rights stay. Where a program is under a licence that requires us to offer its source code, you can ask for it at [[source request contact]].

Data from public services keeps the terms of its owner (for example attribution or fair-use rules). Ghost shows the required attribution in the app and in reports. You must keep it when you share a report.

We do not own, run or control those programs and services. They can change or stop at any time. Ghost may stop working with one of them. We give no promise that any particular tool or source will keep being available.` },
  { title: `7. What stays on your computer`, body: `Ghost keeps your cases, notes, keys and scan log in the Ghost vault on your computer, encrypted before anything is stored. We cannot read them and we cannot recover them. If you turn on the vault's optional backup, you are responsible for keeping the passphrase and recovery phrase safe. If you lose every key, nobody can open your data.

Ghost sends nothing to us about what you look up. When you run a lookup, the name or address you looked up is sent to the one public service that answers it, as shown beside that tool. Ghost has no analytics, usage counters or crash reports.

Mayfair keeps these records with your Mayfair ID: your access application, its outcome and expiry, and which version of these Terms you accepted, with a fingerprint of the text and the date and time.` },
  { title: `8. Your cases, reports and what you do with them`, body: `You own the cases and reports you make. You are responsible for them and for how you share or publish them, including the accuracy of what you say and the rights of the people and organisations they mention.

You agree to [[indemnity wording, subject to legal advice]] for claims that arise from your use of Ghost in breach of these Terms or the law.` },
  { title: `9. No promise that results are complete or correct`, body: `Ghost and the open-source tools it uses are provided "as is". We do not promise that results are complete, current or correct, that a tool will find everything that exists, or that a scan will find every weakness. A result that shows nothing does not prove nothing is there.

[[Disclaimer of warranties, subject to local consumer law]]` },
  { title: `10. Our responsibility to you`, body: `Nothing in these Terms limits liability that cannot be limited by law.

[[Limitation and exclusion of liability, subject to legal advice]]` },
  { title: `11. If you break these Terms, and ending your use`, body: `You can stop using Ghost at any time and remove it from the App Library. Removing it deletes the downloaded tools. Your cases stay in your vault until you delete them.

If you break these Terms, your right to use Ghost ends. We may withdraw your access approval and stop offering Ghost updates and tool downloads to your account [[describe what Mayfair can and will do]]. Parts of these Terms that are meant to continue (for example your responsibility for what you did) continue.` },
  { title: `12. Changes to these Terms`, body: `We may update these Terms. When the changes are important, Ghost shows the new Terms and asks you to accept them before you run another tool. If you do not accept, you can keep your cases and export them, but you cannot run new lookups until you do.` },
  { title: `13. Law and courts`, body: `These Terms are governed by the laws of [[governing law]]. Courts of [[court location]] decide disputes, except where the law gives you the right to go to your local courts.` },
  { title: `14. Contact`, body: `Questions about these Terms, requests for source code, and reports of misuse: [[contact address]].

Copyright The Mayfair Organization.` },
];

const text = () => CLAUSES.map((c) => c.title + '\n\n' + c.body).join('\n\n');
const SHA256 = crypto.createHash('sha256').update(text(), 'utf8').digest('hex');
const major = (v) => String(v || '').split('.')[0];
const placeholders = () => (text().match(/\[\[[^\]]+\]\]/g) || []);

module.exports = { VERSION, CLAUSES, SHA256, text, major, placeholders };
