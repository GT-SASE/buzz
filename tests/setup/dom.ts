import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000" });

mock.module("next/navigation", () => import("../mocks/next-navigation"));
