module.exports = {
    name: "silentmode",
    category: "owner",
    command: ["self2"],
    owner: true,
    description: "Aktifkan mode senyap: command user diabaikan, pelanggaran tetap ditindak",
    run: async (context) => {
        const { sock, isCreator, reply } = context;

        if (!isCreator) return;

        if (sock.silentMode === true) return reply("Sudah dalam Silent Mode (self2)");
        sock.public = true;
        sock.silentMode = true;
        return reply(
            "Success To Silent Mode (self2)\n" +
            "> Command user biasa : *diabaikan tanpa respon*\n" +
            "> Pelanggaran grup : *tetap dideteksi & dihapus*\n" +
            "> Matikan : */public*"
        );
    }
};
