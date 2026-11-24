// Development-only gallery: every design-system primitive in every state.
// Driven by scripts/check-primitives-browser.mjs; nothing here ships.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertDialog,
  Button,
  Checkbox,
  ContextMenu,
  Dialog,
  Disclosure,
  Empty,
  IconButton,
  Input,
  Kbd,
  LiveStatusSpinner,
  Menu,
  Popover,
  Radio,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Select,
  Separator,
  Shimmer,
  ShortcutPill,
  Skeleton,
  Slider,
  Spinner,
  StatusChip,
  Switch,
  Tabs,
  Textarea,
  ToastProvider,
  Tooltip,
  TooltipProvider,
  useToast,
  type ButtonSize,
  type ButtonVariant,
  type ChipTone,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

// lucide-react is a packages/ui dependency, so the gallery draws its own glyphs.
function Glyph({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </svg>
  );
}
const Archive = Glyph, Copy = Glyph, FolderOpen = Glyph, Inbox = Glyph, Pencil = Glyph, Trash2 = Glyph;

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") === "light" ? "light" : "dark";
if (query.get("reduce-motion") === "1") document.documentElement.dataset.reduceMotion = "true";

const variants: ButtonVariant[] = [
  "default", "secondary", "destructive", "prominent", "outline",
  "primary-outline", "destructive-outline", "ghost", "chrome", "subtle", "link",
];
const sizes: ButtonSize[] = ["chip", "xs", "sm", "md", "lg", "xl"];
const tones: ChipTone[] = ["neutral", "info", "success", "warning", "danger", "accent"];
const models = ["Claude Sonnet", "GPT-5", "Gemini Pro"];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ display: "grid", gap: 12, padding: "20px 0", borderBottom: "1px solid var(--gyro-border-light)" }}>
      <h2 style={{ margin: 0, fontSize: "var(--gyro-text-ui)", color: "var(--gyro-text-secondary)", fontWeight: "var(--gyro-weight-medium)" }}>{title}</h2>
      {children}
    </section>
  );
}
const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>{children}</div>
);

function ToastButtons() {
  const toast = useToast();
  return (
    <Row>
      <Button id="g-toast" variant="outline" onClick={() => toast.show({ title: "Saved", description: "Settings updated.", tone: "success" })}>Show toast</Button>
      <Button variant="outline" onClick={() => toast.show({ title: "Failed", description: "Provider unreachable.", tone: "danger", action: { label: "Retry", onClick: () => undefined } })}>Show error toast</Button>
    </Row>
  );
}

function Gallery() {
  const [model, setModel] = useState<string | null>(models[0] ?? null);
  const [segment, setSegment] = useState("chat");
  const [search, setSearch] = useState("");
  const [density, setDensity] = useState<number[]>([50]);
  return (
    <main style={{ padding: "var(--gyro-space-panel)", color: "var(--gyro-text-primary)", background: "var(--gyro-surface-under)", minHeight: "100vh", maxWidth: 960 }}>
      <Section id="buttons" title="Buttons">
        {variants.map((variant) => (
          <Row key={variant}>
            {sizes.map((size) => (
              <Button key={size} variant={variant} size={size}>{variant} {size}</Button>
            ))}
            <IconButton label={`${variant} icon`} variant={variant} size="md"><Copy aria-hidden size={14} /></IconButton>
            <Button variant={variant} disabled>Disabled</Button>
            <Button variant={variant} loading>Loading</Button>
          </Row>
        ))}
        <Row>
          <Button shape="capsule" variant="prominent" leading={<Pencil aria-hidden size={14} />}>Capsule</Button>
          <IconButton label="Send" variant="prominent" shape="capsule"><Archive aria-hidden size={14} /></IconButton>
        </Row>
      </Section>

      <Section id="feedback" title="Feedback">
        <Row>
          {tones.map((tone) => <StatusChip key={tone} tone={tone} dot pulse={tone === "info"}>{tone}</StatusChip>)}
        </Row>
        <Row>
          <Spinner size="xs" /><Spinner size="sm" /><Spinner size="md" /><Spinner size="lg" />
          <LiveStatusSpinner size="md" /><LiveStatusSpinner size="md" pace="slow" />
          <Shimmer>Thinking…</Shimmer>
        </Row>
        <Row>
          <Skeleton width="180px" /><Skeleton shape="circle" width="28px" height="28px" /><Skeleton shape="block" width="120px" height="48px" />
        </Row>
        <Row>
          <Kbd>⌘</Kbd><Kbd>K</Kbd><ShortcutPill keys={["⌘", "Enter"]} />
        </Row>
        <Empty
          icon={<Inbox aria-hidden size={18} />}
          sideIcons={[<FolderOpen aria-hidden key="a" size={14} />, <Archive aria-hidden key="b" size={14} />]}
          title="Nothing here yet"
          description="Start a chat and it shows up in this list."
          actions={<Button size="sm" variant="outline">New chat</Button>}
        />
      </Section>

      <Section id="controls" title="Form controls">
        <Row>
          <Input placeholder="Input" aria-label="Input" />
          <Input placeholder="Invalid" aria-label="Invalid input" invalid />
          <Input placeholder="Disabled" aria-label="Disabled input" disabled />
          <SearchField value={search} onValueChange={setSearch} placeholder="Search" aria-label="Search" hint={<Kbd>/</Kbd>} />
        </Row>
        <Textarea placeholder="Textarea" aria-label="Textarea" rows={2} />
        <Row>
          <Switch aria-label="Switch" defaultChecked /><Switch aria-label="Switch off" />
          <Checkbox aria-label="Checkbox" defaultChecked /><Checkbox aria-label="Checkbox off" />
          <Radio.Group defaultValue="a" aria-label="Radios">
            <Radio.Item value="a" aria-label="A" /><Radio.Item value="b" aria-label="B" />
          </Radio.Group>
        </Row>
        <SegmentedControl
          aria-label="Mode"
          value={segment}
          onValueChange={setSegment}
          options={[{ value: "chat", label: "Chat" }, { value: "code", label: "Code" }, { value: "ide", label: "IDE" }]}
        />
        <div style={{ maxWidth: 240 }}>
          <Slider aria-label="Density" value={density} onValueChange={(v) => setDensity(Array.isArray(v) ? [...v] : [v])} />
        </div>
      </Section>

      <Section id="popups" title="Menus, popovers, select, tooltip">
        <Row>
          <Menu.Root>
            <Menu.Trigger id="g-menu-trigger" render={<Button variant="outline">Menu</Button>} />
            <Menu.Content>
              <Menu.Item id="g-menu-item" icon={<Pencil aria-hidden size={14} />} shortcut="⌘R">Rename</Menu.Item>
              <Menu.Item icon={<Copy aria-hidden size={14} />}>Duplicate</Menu.Item>
              <Menu.Separator />
              <Menu.CheckboxItem defaultChecked>Pinned</Menu.CheckboxItem>
              <Menu.Separator />
              <Menu.Item tone="danger" icon={<Trash2 aria-hidden size={14} />}>Delete</Menu.Item>
            </Menu.Content>
          </Menu.Root>

          <ContextMenu.Root>
            <ContextMenu.Trigger id="g-context-trigger" render={<div style={{ padding: "8px 16px", border: "1px dashed var(--gyro-border)", borderRadius: "var(--gyro-radius-md)", color: "var(--gyro-text-tertiary)" }}>Right-click</div>} />
            <ContextMenu.Content>
              <ContextMenu.Item>Open</ContextMenu.Item>
              <ContextMenu.Item>Reveal</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>

          <Popover.Root>
            <Popover.Trigger id="g-popover-trigger" render={<Button variant="outline">Popover</Button>} />
            <Popover.Content>
              <Popover.Title>Environment</Popover.Title>
              <Popover.Description>Runs locally on this Mac.</Popover.Description>
            </Popover.Content>
          </Popover.Root>

          <Select.Root value={model} onValueChange={setModel}>
            <Select.Trigger id="g-select-trigger" aria-label="Model" placeholder="Model" />
            <Select.Content>
              {models.map((name) => <Select.Item key={name} value={name} description="Provider">{name}</Select.Item>)}
            </Select.Content>
          </Select.Root>

          <Tooltip content="Copy message" shortcut="⌘C">
            <IconButton id="g-tooltip-trigger" label="Copy"><Copy aria-hidden size={14} /></IconButton>
          </Tooltip>
        </Row>
      </Section>

      <Section id="dialogs" title="Dialogs and toasts">
        <Row>
          <Dialog.Root>
            <Dialog.Trigger id="g-dialog-trigger" render={<Button variant="outline">Dialog</Button>} />
            <Dialog.Content showClose>
              <Dialog.Header>
                <Dialog.Title>Rename workspace</Dialog.Title>
                <Dialog.Description>Choose a name that is easy to find later.</Dialog.Description>
              </Dialog.Header>
              <Dialog.Body><Input aria-label="Name" defaultValue="Gyro" /></Dialog.Body>
              <Dialog.Footer>
                <Dialog.Close render={<Button variant="ghost">Cancel</Button>} />
                <Dialog.Close render={<Button>Save</Button>} />
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Root>

          <AlertDialog.Root>
            <AlertDialog.Trigger id="g-alert-trigger" render={<Button variant="destructive-outline">Alert dialog</Button>} />
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>Delete this chat?</AlertDialog.Title>
                <AlertDialog.Description>This cannot be undone.</AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Close render={<Button variant="ghost">Cancel</Button>} />
                <AlertDialog.Close render={<Button variant="destructive">Delete</Button>} />
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Row>
        <ToastButtons />
      </Section>

      <Section id="structure" title="Tabs, disclosure, scroll, separator">
        <Tabs.Root defaultValue="one">
          <Tabs.List aria-label="Tabs">
            <Tabs.Tab value="one">One</Tabs.Tab>
            <Tabs.Tab value="two">Two</Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>
          <Tabs.Panel value="one">First panel</Tabs.Panel>
          <Tabs.Panel value="two">Second panel</Tabs.Panel>
        </Tabs.Root>
        <Disclosure title="Disclosure" meta="3">
          <p style={{ margin: 0 }}>Folded content.</p>
        </Disclosure>
        <Separator />
        <ScrollArea style={{ maxHeight: 80 }}>
          {Array.from({ length: 12 }, (_, i) => <div key={i}>Row {i + 1}</div>)}
        </ScrollArea>
      </Section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider><ToastProvider><Gallery /></ToastProvider></TooltipProvider>,
);
