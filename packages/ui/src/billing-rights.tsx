import { SettingsGroup, SettingsRow } from "./settings-controls";
import { openExternalLink } from "./external-links";
import { ArrowUpRight } from "lucide-react";

/** Public rights routes remain available without paid access or sign-in. */
export function BillingRights() {
  return (
    <SettingsGroup id="billing-rights" label="Terms and consumer rights">
      <p>Withdrawal, stopping renewal, refunds and deleting Cloud data are separate requests.</p>
      {[
        ["Read Cloud terms", "https://usegyro.io/terms/"],
        ["Download contract information", "https://usegyro.io/legal/2026-11-12-v4/cloud-contract.txt"],
        ["Withdraw from contract", "https://usegyro.io/withdrawal/"],
        ["Privacy and deletion", "https://usegyro.io/privacy/"],
        ["Contact support", "https://usegyro.io/contact/"],
      ].map(([label, url]) => (
        <SettingsRow key={url} label={label!} onClick={() => openExternalLink(url!)}>
          <ArrowUpRight size={16} aria-hidden="true" />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
