const mongoose = require('mongoose');

const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });

const messageSchema = new mongoose.Schema(
  { author: { ...ref('User'), required: true }, text: { type: String, required: true } },
  { timestamps: true }
);

const memberSchema = new mongoose.Schema(
  { user: { ...ref('User'), required: true, unique: true } },
  { timestamps: true }
);

// One report per reporter per person, so 3 reports always means 3 different members
const reportSchema = new mongoose.Schema(
  {
    reporter: { ...ref('User'), required: true },
    reported: { ...ref('User'), required: true },
    message: { ...ref('CommunityMessage'), default: null },
    reason: { type: String, default: '' },
  },
  { timestamps: true }
);
reportSchema.index({ reporter: 1, reported: 1 }, { unique: true });

module.exports = {
  CommunityMessage: mongoose.models.CommunityMessage || mongoose.model('CommunityMessage', messageSchema),
  CommunityMember: mongoose.models.CommunityMember || mongoose.model('CommunityMember', memberSchema),
  CommunityReport: mongoose.models.CommunityReport || mongoose.model('CommunityReport', reportSchema),
};
