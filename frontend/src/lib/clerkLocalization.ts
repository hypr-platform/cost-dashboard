import { ptBR } from "@clerk/localizations";

export const clerkLocalizationPtBr = {
  ...ptBR,
  signIn: {
    ...ptBR.signIn,
    start: {
      ...ptBR.signIn?.start,
      titleCombined: "Entre em HYPR Cost Dashboard",
    },
  },
};
