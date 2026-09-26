import type { DefaultSession } from "next-auth";

/**
 * `Session` and `JWT` are declared in `@auth/core` and only re-exported by
 * `next-auth`, so the augmentations have to target the declaring modules.
 */
declare module "@auth/core/types" {
  interface Session {
    user: {
      id: string;
      /**
       * The GitHub OAuth access token for this session, present only when the
       * user signed in through GitHub.
       *
       * This is sent to the browser on purpose: the WebContainer runs git
       * client-side and needs the token to talk to GitHub. It is therefore
       * readable by any script running on this origin, which is why the
       * provider is scoped to `public_repo` rather than `repo`.
       */
      githubAccessToken?: string;
      /** The GitHub login this token belongs to, e.g. "octocat". */
      githubLogin?: string;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    githubAccessToken?: string;
    githubLogin?: string;
  }
}
