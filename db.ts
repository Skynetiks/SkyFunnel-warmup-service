import { getEmailCredentials } from "./src/helpers/database"
import { encryptToken } from "./src/helpers/encryption"

const main = async () => {
    const secretKey = "b1c42e16c5a057cd3a0d1fbe9279a8c87b6a82d6f6a8c8c57679a4e7b0c1b2e1e"
    const pass = encryptToken("kvpk nsqu fqmt nxyp", secretKey)
    console.log(pass)
    // const res = getEmailCredentials("deewanshu@skynetiks.com")
    // console.log(res)
}
main()