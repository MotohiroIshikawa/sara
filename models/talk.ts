import mongoose from "mongoose";

const Schema = mongoose.Schema;
const TalkSchema = new Schema({
  user: {
    type: String,
    required: true,
  },
  contents: {
    type: String,
    required: true,
  },
  dist: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
  }
})

export const TalkModel = mongoose.models.Talk || mongoose.model("Talk", TalkSchema)