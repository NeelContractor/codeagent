"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function ModeToggle() {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      {/*
        This project builds on Base UI, which has no `asChild`. The trigger is
        customised with a `render` element instead, so it still renders the
        shadcn Button rather than a bare button.
      */}
      <DropdownMenuTrigger
        render={
          // `relative` anchors the absolutely positioned moon icon to the
          // button; the base Button styles do not position it.
          <Button variant="outline" size="icon" className="relative">
            <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
            <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            <span className="sr-only">Toggle theme</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {/*
          DropdownMenuLabel is Base UI's Menu.GroupLabel, so it (and the items
          it labels) must sit inside a Menu.Group or the popup throws
          "MenuGroupContext is missing" and renders nothing.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          {THEMES.map((theme) => (
            <DropdownMenuItem
              key={theme.value}
              onClick={() => setTheme(theme.value)}
            >
              {theme.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
