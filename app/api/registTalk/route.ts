import { TalkModel } from '@/models/talk'
import connectDB from '@/utils/connectDB'

const registTalk = async (req, res) => {
    try {
      await connectDB()
      await TalkModel.create(req.body)    
      return res.status(200).json({ message: "トーク登録成功", created: true })
    } catch {
        return res.status(400).json({ message: "トーク登録失敗" })
    }
}

export default registTalk