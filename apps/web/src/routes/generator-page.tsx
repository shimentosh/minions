import { Page, PageBody, Section } from "@/components/layout/page";
import { PasswordGenerator } from "@/components/vault/password-generator";
import { useUi } from "@/lib/ui-store";

export function GeneratorPage() {
  const openEditor = useUi((s) => s.openEditor);
  return (
    <Page title="Password generator">
      <PageBody
        title="Password generator"
        subtitle="Strong, random passwords, generated on this device."
        className="max-w-xl"
      >
        <Section title="Generate">
          <PasswordGenerator
            useLabel="Generate & save as a login"
            onUse={(password) => openEditor({ type: "LOGIN", values: { password } })}
          />
        </Section>
      </PageBody>
    </Page>
  );
}
