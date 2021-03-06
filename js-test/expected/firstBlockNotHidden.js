module.exports.output = {
  start: `let app = App(id: YOUR_REALM_APP_ID)
let client = app.emailPasswordAuth()
let email = "skroob@example.com"
let password = "password12345"
client.registerEmail(email, password: password) { (error) in
    guard error == nil else {
        print("Failed to register: \\(error!.localizedDescription)")
        return
    }
    // Registering just registers. You can now log in.
    print("Successfully registered user.")
}`.split('\n')};