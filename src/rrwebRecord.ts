// @rrweb/record ships the recorder as a separately compiled module. Using it
// here prevents an application that also imports rrweb's Replayer from merging
// both lazy capabilities back into rrweb's full shared namespace chunk.
export { record } from "@rrweb/record";
