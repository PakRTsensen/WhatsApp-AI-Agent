module.exports = {
    name: "modebot",
    category: "owner",
    command: ["public", "self"],
    owner: true,
    run: async (context) => {
        const { sock, command, isCreator, reply } = context;

        if (!isCreator) return reply("*Khusus Owner*");

        if (command === "public") {
            if (sock.public === true && !sock.silentMode) return reply("Success To Public Mode");
            sock.public = true;
            sock.silentMode = false;
            return reply("Success To Public Mode");
        }

        if (command === "self") {
            if (sock.public === false && !sock.silentMode) return reply("Success To Self Mode");
            sock.public = false;
            sock.silentMode = false;
            return reply("Success To Self Mode");
        }
    }
};
