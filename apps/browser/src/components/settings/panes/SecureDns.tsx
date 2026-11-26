import { getSecureDns, setSecureDns, type SecureDns } from "@bay/chromium";
import { choiceOf, DNS_PROVIDERS, NEXTDNS, validTemplate, type DnsChoice as Choice } from "../../../lib/secureDns";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../../../lib/theme";
import { Button, Group, PopUp, Row, SectionHeader, Sheet, TextField, useFormColors, type Option } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

// Settings › Privacy › Secure DNS: Chromium's DNS over HTTPS for every space, on every platform. Automatic upgrades to
// the system resolver's own DoH when it has one; a provider sends every lookup to that provider, encrypted.

const OPTIONS: Option<Choice>[] = [
  { value: "automatic", title: "Automatic" },
  { value: "off", title: "Off" },
  ...DNS_PROVIDERS.map((p, i) => ({ value: p.id, title: p.title, separatorBefore: i === 0 })),
  { value: "nextdns", title: "NextDNS…" },
  { value: "custom", title: "Custom…", separatorBefore: true },
];

const DESCRIPTIONS: Record<"off" | "automatic" | "secure", string> = {
  automatic: "Uses encrypted DNS when your network's DNS server offers it, and plain DNS otherwise.",
  off: "Looks up sites with your network's DNS server, unencrypted.",
  secure: "Every lookup goes encrypted to this provider. If it can't be reached, sites don't load.",
};

export function SecureDnsSection() {
  const [dns, setDns] = useState<SecureDns | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () =>
    void getSecureDns()
      .then(setDns)
      .catch(() => setFailed(true));

  useEffect(load, []);

  if (failed || !dns) return null;
  const choice = choiceOf(dns);

  const apply = (mode: SecureDns["mode"], templates = "") => void setSecureDns(mode, templates).then(load, load);

  const choose = (next: Choice) => {
    if (next === "off" || next === "automatic") return apply(next);

    if (next === "nextdns" || next === "custom")
      return showSettingsSheet(<TemplateSheet kind={next} current={dns.templates} onSave={(t) => apply("secure", t)} />);
    const provider = DNS_PROVIDERS.find((p) => p.id === next);

    if (provider) apply("secure", provider.template);
  };

  return (
    <>
      <SectionHeader title="Network" />
      <Group>
        <Row
          settingId={SETTINGS.secureDns.id}
          title={SETTINGS.secureDns.title}
          description={dns.managed ? "Set by your organization." : `${DESCRIPTIONS[dns.mode]}${choice === "custom" ? ` ${dns.templates}` : ""}`}
        >
          <PopUp value={choice} options={OPTIONS} disabled={dns.managed} onChange={choose} minWidth={190} />
        </Row>
      </Group>
    </>
  );
}

function TemplateSheet({ kind, current, onSave }: { kind: "nextdns" | "custom"; current: string; onSave: (template: string) => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const [text, setText] = useState(kind === "nextdns" ? (current.match(NEXTDNS)?.[1] ?? "") : current);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const template = kind === "nextdns" ? `https://dns.nextdns.io/${text.trim()}` : text.trim();

    if (kind === "nextdns" ? !/^[a-z0-9]+$/i.test(text.trim()) : !validTemplate(template))
      return setError(kind === "nextdns" ? "Enter your configuration ID, like abc123." : "Enter an https:// address, with {?dns} if it takes the query.");
    onSave(template);
    closeSettingsSheet();
  };

  return (
    <Sheet width={440} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{kind === "nextdns" ? "NextDNS" : "Custom DNS Provider"}</Text>
      <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>
        {kind === "nextdns" ? "Configuration ID (from my.nextdns.io)" : "DNS-over-HTTPS address"}
      </Text>
      <TextField
        value={text}
        onChangeText={setText}
        placeholder={kind === "nextdns" ? "abc123" : "https://dns.example.com/dns-query{?dns}"}
        onSubmit={save}
        onEscape={closeSettingsSheet}
        autoFocus
      />
      {error && <Text style={{ fontSize: 12, marginTop: 10, color: colors.destructive }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Use" kind="primary" onPress={save} />
      </View>
    </Sheet>
  );
}
