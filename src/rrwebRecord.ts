// Keep the recorder behind its own lazy boundary while exposing only rrweb's
// named record export to consumer bundlers. Importing the rrweb namespace here
// retains the player and its dependencies in recorder-only application chunks.
export { record } from "rrweb";
