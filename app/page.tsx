import type { Metadata } from "next";
import { AppShell } from "./components/AppShell";

export const metadata: Metadata = {
  title: "MIDIocre — Piano Tutor",
  description: "Turn piano MIDI files into focused, resumable practice plans.",
};

export default function Home() {
  return <AppShell />;
}
