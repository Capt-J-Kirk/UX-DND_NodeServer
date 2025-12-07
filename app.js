const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const mysql = require('mysql');
const genericPool = require('generic-pool');
const crypto = require('crypto');
const express = require('express'); 
const util = require('util');
const app = express();
/*
const options = {
    key: fs.readFileSync('certs/key.pem'),
    cert: fs.readFileSync('certs/cert.pem')
};
*/

// Host & port settings.
const localPort = 3000;
const httpPort = 80;
const httpsPort = 443;
const localHost = '127.0.0.1';
const publicHost = 'xxx.xxx.xxx.xxx';
// --------------

// Table names.
const scenes = 'UX_DND_sceneTable';
const games  = 'UX_DND_gameTable';
const gameToScene       = 'UX_DND_gameToSceneTable';
const trainingSets      = 'UX_DND_trainingSetTable';
const trainingSetToGame = 'UX_DND_trainingSetToGameTable';
// --------------


// JSON post -------------
app.use(express.json({limit: '50mb'}));
//support parsing of application/x-www-form-urlencoded post data
app.use(express.urlencoded({limit: '50mb', extended: true, parameterLimit: 50000})); //Parse URL-encoded bodies
// -----------------------

// Path to public files.
let publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Logging.
let showQueries = true;
let showResults = true;
let showComments = true;
let showErrors = true;

// Pool settings (pool of connections).
const poolCnf = {
    connectionLimit : 10,
    host: 'myHost',
    user: 'myUser',
    password: 'myPass',
    database: 'myDB'
};

// Creating a pool for connections.
const pool = mysql.createPool(poolCnf);


// Creating a database wrapper.
const DB = {
    query: (sql, args) => {
      return new Promise((resolve, reject) => {
        pool.query(sql, args, (err, rows) => {
          if (err) {
            return reject(err);
          }
          resolve(rows);
        });
      });
    },
    transaction: () => {
      return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
          if (err) {
            return reject(err);
          }
          connection.beginTransaction((err) => {
            if (err) {
              return reject(err);
            }
            resolve({
              commit: () => {
                return new Promise((resolve, reject) => {
                  connection.commit((err) => {
                    if (err) {
                      connection.rollback(() => {
                        reject(err);
                      });
                    } else {
                      connection.release();
                      resolve();
                    }
                  });
                });
              },
              rollback: () => {
                return new Promise((resolve, reject) => {
                  connection.rollback(() => {
                    connection.release();
                    resolve();
                  });
                });
              },
              query: (sql, args) => {
                return new Promise((resolve, reject) => {
                  connection.query(sql, args, (err, rows) => {
                    if (err) {
                      connection.rollback(() => {
                        reject(err);
                      });
                    } else {
                      resolve(rows);
                    }
                  });
                });
              },
            });
          });
        });
      });
    },
};
  

SetupTables(DB);

// Tables needed in the database are set up, if they do not already exist.
async function SetupTables(DB) {
    let query = '';
    let queries = [];

    let query01 =`
    CREATE TABLE IF NOT EXISTS ${scenes}(
        id INT PRIMARY KEY AUTO_INCREMENT,
        sceneType VARCHAR(100),
        keyFreq FLOAT,
        mouseButtonFreq FLOAT,
        swipeFreq FLOAT,
        avgSwipeSpeed FLOAT,
        killDeathRatio FLOAT,
        belowAbove50HpRatio FLOAT,
        hitRatio FLOAT,
        damageGivenTakenRatio FLOAT,
        questCompletionRatio FLOAT,
        sceneDuration INT,
        kills INT,
        deaths INT,
        completedQuests INT,
        keyData MEDIUMTEXT,
        mouseData MEDIUMTEXT,
        generalExp INT,
        diffExp INT,
        otherExp INT,
        dateTime DATETIME
        );
    `;

    let query02 =`
    CREATE TABLE IF NOT EXISTS ${games}(
        id INT PRIMARY KEY AUTO_INCREMENT,
        playerId VARCHAR(100),
        isControlGroup BOOL,
        playerType INT,
        playerSkill INT,
        sceneCount INT,
        gameComplete BOOL
        );
    `; 
    
    let query03 =`
    CREATE TABLE IF NOT EXISTS ${gameToScene}(
        id INT PRIMARY KEY AUTO_INCREMENT,
        gameId INT,
        sceneId INT,
        FOREIGN KEY (gameId) REFERENCES ${games}(id),
        FOREIGN KEY (sceneId) REFERENCES ${scenes}(id)
        );
    `;             

    let query04 =`
    CREATE TABLE IF NOT EXISTS ${trainingSets}(
        id INT PRIMARY KEY AUTO_INCREMENT,
        setName VARCHAR(100),
        gamesAllowed INT,
        weightBias_BLOB MEDIUMTEXT,
        qTableGeneralExp_BLOB MEDIUMTEXT,
        qTableDiffExp_BLOB MEDIUMTEXT,
        active BOOL
        );
    `;     

    let query05 =`
    CREATE TABLE IF NOT EXISTS ${trainingSetToGame}(
        id INT PRIMARY KEY AUTO_INCREMENT,
        trainingSetId INT,
        gameId INT,
        FOREIGN KEY (trainingSetId) REFERENCES ${trainingSets}(id),
        FOREIGN KEY (gameId) REFERENCES ${games}(id)
        );
    `; 

   
    queries.push(query01, query02, query03, query04, query05);    
    const tx = await DB.transaction();
    try {
      for (let i=0; i<queries.length; i++) {
          query = queries[i];
          await tx.query(query);
          if (showQueries) console.log("Successful query: " + query);
      }
      await tx.commit();
      if (showComments) console.log('Transaction committed successfully.');
    } 
    catch (err) {
        console.error(err);
        await tx.rollback();
    }
    finally {
        // For R-Studio
        // GetSceneBatch(DB, true);
    }
}

async function CreateNewTrainingSet_SetActive(db, trainingSetName, gamesAllowed, activateTheSet) {

    let query = '';
    let reply = {};
    reply.success = false;
    reply.text = `Training set ${trainingSetName} was NOT created.`;

    let query0 =`
        SELECT * FROM ${trainingSets} WHERE setName = '${trainingSetName}';
    `;    
    let query1 =`
        INSERT INTO ${trainingSets} VALUES (
            id, '${trainingSetName}', '${gamesAllowed}', 'CREATED', 'CREATED', 'CREATED', 0
        );
    `;
    let query2 =`
        UPDATE ${trainingSets} SET active = 0 WHERE active = 1;
    `;


    async function Transaction () {
        const tx = await db.transaction();
        try {
             // ========== Step 1: ##############################################################################
             if (showComments) console.log("#################### STEP 1: Check and create training set. ####################"); 
            query = query0;
            let rows = await tx.query(query);
            // In this case there is a set with that name.
            if (rows.length > 0) {
                reply.success = true;
                reply.text = `Traning set ${rows[0].setName} already exists.`;
                if (showComments) console.log(`Traning set ${trainingSetName} already exists.`);
            }
            // In this case, the training set doesn't exist yet.
            // So we create a new set with that name.
            else {
                query = query1;
                rows = await tx.query(query);
                if (rows.affectedRows > 0) {
                    if (showResults) console.log("Training set created: " + JSON.stringify(rows));
                    reply.success = true;
                    reply.text = `Empty training set with id ${rows.insertId} and name ${trainingSetName} created, NO ML parameters yet.`;
                }
            }

            // Step 2: activating the set if activateTheSet == true.
            if (activateTheSet == true) {
                query = query2;
                rows = await tx.query(query);
                if (rows) {
                    if (showComments) console.log("All training sets deactivated.");
                }
                let query3 =`
                    UPDATE ${trainingSets} SET active = 1 WHERE setName = '${trainingSetName}';
                `;
                query = query3;
                rows = await tx.query(query);
                if (rows) {
                    reply.success = true;
                    reply.text += ` Training set ${trainingSetName} was activated.`;
                    if (showComments) console.log(`Training set ${trainingSetName} was activated.`);
                }
            }


            // ========== Last step: commiting the queries.
            await tx.commit();
            if (showComments) console.log('Transaction committed successfully.\n');
            return reply;  // Returning reply (to post-request by Unity game).
        }
        catch (err) {
            console.error(err);
            await tx.rollback();
            throw err;
        }
    };
    reply = await Transaction();
    return reply;    
}


async function CheckGameCount (db,  trainingSetName, givenPlayerId) {
  
    let query = '';
    let reply = {};
    reply.success = false;
    reply.text = "Game count NOT obtained.";
    reply.numGamesPlayed = -1;
    reply.numGamesAllowed = -1; 

    let activeTrainingSetID = -1;

    let query0 =`
        SELECT * FROM ${trainingSets} WHERE active = 1 AND setName = '${trainingSetName}';
    `;    
    



    async function Transaction () {
        const tx = await db.transaction();
        try {
            // Step 1: ####################################################            
            if (showComments) console.log("#################### STEP 1: Find id of training set, if it exists. ####################"); 
            if (showComments) console.log("Asking for set: " + trainingSetName);
            query = query0;
            let rows = await tx.query(query);
            // In this case there is an active set.
            if (rows.length > 0) {
                activeTrainingSetID = rows[rows.length - 1].id; // Use this in next step.

                console.log("Found trSetId:" + activeTrainingSetID);
                
                reply.numGamesAllowed = rows[rows.length - 1].gamesAllowed;
            }
            // In this case the set is not found, gameCount is set to 0.
            else {
                reply.success = true;
                reply.text = `Training set not found. TestGamesPlayed will be set to 0.`;
                reply.numGamesPlayed = 0;
                reply.numGamesAllowed = 1;
                if (showResults) console.log(reply.text);
            }

            // Step 2: ####################################################
            if (showComments) console.log("#################### STEP 2: Find games played and allowed ####################"); 
            if (activeTrainingSetID > 0) {
                let query1 =`
                    SELECT ${trainingSetToGame}.gameId, ${games}.id, ${games}.playerId 
                    FROM ${trainingSetToGame}
                    LEFT JOIN ${games}
                    ON ${trainingSetToGame}.gameId = ${games}.id
                    WHERE ${trainingSetToGame}.trainingSetId = ${activeTrainingSetID} AND ${games}.playerId = '${givenPlayerId}';
                `; 
                query = query1;  
                rows = await tx.query(query);
                if (showResults) console.log("JOIN:" + JSON.stringify(rows));
                if (rows.length > 0) {
                    reply.success = true;
                    reply.numGamesPlayed = rows.length;    
                    reply.text = `Number of games played, successfully found: ${rows.length}`;
                    if (showResults) console.log(`Games found with playerId=givenPlayerId : ${rows.length}`);
                }
                else {
                    reply.success = true;
                    reply.numGamesPlayed = 0;    
                    reply.text = `Number of games played was: 0`;
                    if (showResults) console.log(`Games found with playerId=givenPlayerId : 0`);
                }
            }

            // Last: ####################################################            
            if (showComments) console.log("#################### LAST STEP, COMMITTING ####################");            
            await tx.commit();
            if (showComments) console.log('##### Commit done #####\n');
            return reply;  // Returning reply (to post-request by Unity game).
        }
        catch (err) {
            console.error(err);
            await tx.rollback();
            throw err;
        }
    };
    reply = await Transaction();
    return reply;
}


async function GetML_Parameters (db) {
  
    let query = '';
    let reply = {};
    reply.success = false;
    reply.text = "Machine Learning parameters NOT obtained.";
    reply.trainingSetID = 0;
    reply.trainingSetName = "";
    reply.newEpisode = 0;
    reply.weightBias_BLOB = "NO_DATA";
    reply.qTableGeneralExp_BLOB = "NO_DATA";
    reply.qTableDiffExp_BLOB = "NO_DATA";

    let activeTrainingSetID = 0;

    let query0 =`
        SELECT * FROM ${trainingSets} WHERE active = 1;
    `;    
    
    async function Transaction () {
        const tx = await db.transaction();
        try {
            // Step 1: ####################################################            
            if (showComments) console.log("#################### STEP 1: Find id of active training set. ####################"); 
            query = query0;
            let rows = await tx.query(query);
            // In this case there is an active set, so we get the ID of the set and the BLOBs.
            if (rows.length > 0) {
                reply.success = true;
                reply.text = "Machine Learning parameters SUCCESSFULLY obtained.";
                // Number of episodes will be found in the next step.
                activeTrainingSetID = rows[rows.length - 1].id; // Use this in next step.
                reply.trainingSetID = activeTrainingSetID;
                reply.trainingSetName = rows[rows.length - 1].setName;
                reply.weightBias_BLOB = rows[rows.length - 1].weightBias_BLOB;
                reply.qTableGeneralExp_BLOB = rows[rows.length - 1].qTableGeneralExp_BLOB;
                reply.qTableDiffExp_BLOB = rows[rows.length - 1].qTableDiffExp_BLOB;
                //console.log("REPLY: " + JSON.stringify(reply));
            }
            // In this case, no active set is found. We issue a warning.
            else {
                reply.text += ` ERROR: no active training set found`;
                if (showErrors) console.log("ERROR: no active training set found.");
            }

            // Step 2: ####################################################
            if (showComments) console.log("#################### STEP 2: Find episode ####################"); 
            // Find the new episode number (scenes played + 1).
            if (activeTrainingSetID > 0) {
                let query1 =`
                    SELECT ${trainingSetToGame}.gameId, ${games}.sceneCount FROM ${trainingSetToGame}
                    LEFT JOIN ${games}
                    ON ${trainingSetToGame}.gameId = ${games}.id
                    WHERE ${trainingSetToGame}.trainingSetId = ${activeTrainingSetID};
                `; 
                query = query1;  
                rows = await tx.query(query);
                if (showResults) console.log("JOIN:" + JSON.stringify(rows));
                if (rows) {
                    let episodes = 0;
                    for (let i = 0; i < rows.length; i++) {
                        episodes += rows[i].sceneCount;
                    }
                    reply.newEpisode = episodes + 1; // Add 1 for a new episode.
                    // #########################################################
                    // HARDCODING: HAVE TO KEEP EPISODES WELL BELOW 40 (BUILD HAS DECAY TIME TO 40)
                    if (reply.episodes > 25) reply.episodes = 25;
                    // #########################################################
                    if (showResults) console.log(`New episode number: ${reply.newEpisode}\n`);
                    if (showResults) console.log("Games with episodes (scenes) found:\n" + JSON.stringify(rows));
                }
                else {
                    if (showErrors) console.log("Warning: new episode number is still 0");
                }
            }

            // Last: ####################################################            
            if (showComments) console.log("#################### LAST STEP, COMMITTING ####################");            
            await tx.commit();
            if (showComments) console.log('##### Commit done #####\n');
            return reply;  // Returning reply (to post-request by Unity game).
        }
        catch (err) {
            console.error(err);
            await tx.rollback();
            throw err;
        }
    };
    reply = await Transaction();
    return reply;
}


async function NewSceneRecord_UpdateSet
    (db, givenSetID, givenWeightBias_BLOB, givenQTableGeneralExp_BLOB, givenQTableDiffExp_BLOB,         // trainingSet table
         givenGameID, playerID, isControlGroup, playerType, playerSkill, gameComplete,                  // games table
         sceneType, keyFreq, mouseButtonFreq, swipeFreq, avgSwipeSpeed,                                 // sceneData table
         killDeathRatio, belowAbove50HpRatio, hitRatio, damageGivenTakenRatio, questCompletionRatio,    // sceneData table
         sceneDuration, kills, deaths, completedQuests,                                                 // sceneData table
         keyData, mouseData, generalExp, diffExp, otherExp                                              // sceneData table
    )
{
    let query = '';
    let reply = {};
    reply.success = false;
    reply.text = "New scene-record NOT created, and training set data NOT updated.";
    reply.gameID = -2;

    let gameID;
    let sceneCount;
    let sceneID;

    let query0 =`
        INSERT INTO ${scenes} VALUES(
            id,
             '${sceneType}', ${keyFreq}, ${mouseButtonFreq}, ${swipeFreq}, ${avgSwipeSpeed},
             ${killDeathRatio}, ${belowAbove50HpRatio}, ${hitRatio}, ${damageGivenTakenRatio}, ${questCompletionRatio},
             ${sceneDuration}, ${kills}, ${deaths}, ${completedQuests},
            '${keyData.replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/,/g, '\\,')}',
            '${mouseData.replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/,/g, '\\,')}',
             ${generalExp}, ${diffExp}, ${otherExp}, NOW()
        );
    `;

    async function Transaction () {
        const tx = await db.transaction();
        try {
            // Step 1 ####################################################          
            if (showComments) console.log("#################### STEP 1: Saving scene, getting sceneID ####################");
            query = query0;
            let rows = await tx.query(query);
            if (rows.affectedRows > 0) {
                sceneID = rows.insertId;
                if (showResults) console.log("Scene record created: " + JSON.stringify(rows));                
            }
            else if (showErrors) console.log("Error: Scene record NOT created.");            

            // Step 2 ####################################################
            if (givenGameID <= 0) {       // Starting new game.
                if (showComments) console.log("#################### STEP 2: Creating a new game & getting gameId ####################");
                let query1 =`
                    INSERT INTO ${games} VALUES(
                        id,
                        '${playerID}',
                         ${isControlGroup},
                         ${playerType},
                         ${playerSkill},
                         1,
                         ${gameComplete}
                    );
                `;    
                query = query1;
                rows = await tx.query(query);
                if (rows.affectedRows > 0) {
                    if (showQueries) console.log("Successful query: " + query);
                    gameID = rows.insertId;
                    reply.gameID = gameID;
                    let query2 = `
                        INSERT INTO ${gameToScene} VALUES(
                            id,
                            ${gameID},
                            ${sceneID}
                        );
                    `;                  
                    query = query2;
                    rows = await tx.query(query);
                    if (rows.affectedRows > 0) {
                        if (showQueries) console.log("Successful query: " + query);
                    }
                    else if (showErrors) console.log(`Error: No insert in ${gameToScene}.`);
                }
                else {
                    if (showErrors) console.log("Error: New game not created!");                   
                }
            }
            // In this case the player is supplying the gameID,
            // which was given be node-server earlier (because it's > 0).
            // Now we have to update an existing game with the new scene count,
            // and add a new line in UX_DND_gameToSceneTable.
            else {
                // Step 2A ####################################################
                if (showComments) console.log("#################### STEP 2A: Updating an existing game ####################");
                // Getting a sceneCount.
                reply.gameID = givenGameID;
                let query3 =`
                    SELECT id FROM ${gameToScene}
                    WHERE gameId = ${givenGameID};
                `;
                query = query3;
                rows = await tx.query(query);
                if (rows.length > 0) {
                    sceneCount = rows.length + 1;   // Adding 1, since we are adding a row now (should have added row first).
                    if (showQueries) console.log("Successful query: " + query);
                    // Setting the sceneCount in games table.
                    let query4 =`
                        UPDATE ${games} 
                        SET sceneCount = ${sceneCount}, gameComplete = ${gameComplete} 
                        WHERE id = ${givenGameID};
                    `;    
                    query = query4;
                    rows = await tx.query(query);
                    if (rows.affectedRows > 0) {
                        if (showQueries) console.log("Successful query: " + query);
                        // Creating new entry in UX_DND_gameToSceneTable.
                        let query5 =`
                            INSERT INTO ${gameToScene} VALUES (id, ${givenGameID}, ${sceneID});
                        `;
                        query = query5;
                        rows = await tx.query(query);
                        if (rows.affectedRows > 0) {
                            if (showQueries) console.log("Successful query: " + query);
                        }
                        else if (showErrors) console.log(`Error: New entry in ${gameToScene} not created: gameId=` + givenGameID + ", sceneId=" + sceneID + ".");
                    }
                    else if (showErrors) console.log("Error: games table not updated on the id " + givenGameID + ".");
                }
                else if (showErrors) console.log("Error: gameId " + givenGameID + ` not found in table ${gameToScene}.`);    
            } 

            // Step 3 ####################################################          
            if (showComments) console.log("#################### STEP 3: Updating trainingSet table ####################");
            let query6 =`
                UPDATE ${trainingSets} SET
                    weightBias_BLOB = '${givenWeightBias_BLOB}',
                    qTableGeneralExp_BLOB = '${givenQTableGeneralExp_BLOB}',
                    qTableDiffExp_BLOB = '${givenQTableDiffExp_BLOB}' 
                WHERE id = ${givenSetID};
            `;  
            query = query6;
            rows = await tx.query(query);
            if (rows.affectedRows > 0) {
                if (showResults) console.log("Training set parameters updated: " + JSON.stringify(rows));
            }
            else if (showResults) console.log("Training set parameters NOT updated: ");

            // Step 4 ####################################################
            if (givenGameID <= 0) {
                if (showComments) console.log(`#################### STEP 4: Adding gameId to ${trainingSetToGame} ####################`);
                let query7 =`
                    INSERT INTO ${trainingSetToGame} VALUES (id, ${givenSetID}, ${gameID});
                `;
                query = query7;
                rows = await tx.query(query);
                if (rows.affectedRows > 0) {
                    let id = rows.insertId;
                    if (showComments) console.log(`New entry in ${trainingSetToGame}: index=` + id + ", setId=" + givenSetID + ", gameId=" + gameID);
                }
            }
            else if (showComments) console.log("This game has already been started on the training set.");

            // Last step ####################################################
            reply.success = true;
            reply.text = "Database SUCCESSFULLY updated with scene data.";
            if (showComments) console.log("#################### COMITTING ####################");
            await tx.commit();
            if (showComments) console.log('##### Commit done #####\n');
            return reply;  // Returning reply (to post-request by Unity game).
        }
        catch (err) {
            console.error(err);
            await tx.rollback();
            throw err;
        }
    };
    reply = await Transaction();
    return reply;
}



async function GetSceneBatch (db, writeFileForRStudio) {
  
    let query = '';
    let reply = {};
    reply.success = false;
    reply.text = "NO scene data were obtained.";
    reply.sceneDataBatchString = "NO_SCENES_OBTAINED";

    let query1 =`
        SELECT scenes.id, ${scenes}.sceneType, ${games}.playerType, ${games}.playerSkill,
        ${scenes}.keyFreq, ${scenes}.mouseButtonFreq, ${scenes}.swipeFreq, ${scenes}.avgSwipeSpeed,
        ${scenes}.killDeathRatio, ${scenes}.belowAbove50HpRatio, ${scenes}.hitRatio, ${scenes}.damageGivenTakenRatio, ${scenes}.questCompletionRatio,
        ${scenes}.sceneDuration, ${scenes}.kills, ${scenes}.deaths, ${scenes}.completedQuests,
        ${scenes}.generalExp, ${scenes}.diffExp, ${scenes}.otherExp
        FROM ${trainingSets}
        LEFT JOIN ${trainingSetToGame}
        ON ${trainingSets}.id = ${trainingSetToGame}.trainingSetId
        LEFT JOIN ${games}
        ON ${trainingSetToGame}.gameId = ${games}.id
        LEFT JOIN ${gameToScene}
        ON ${games}.id = ${gameToScene}.gameId
        LEFT JOIN ${scenes}
        ON ${gameToScene}.sceneId = ${scenes}.id
        WHERE (${trainingSets}.id = 2 OR ${trainingSets}.id = 3);
    `;     

    let query2 =`
        SELECT ${games}.id AS gameId, ${games}.isControlGroup, ${games}.playerType, ${games}.playerSkill, ${games}.sceneCount,
        ${scenes}.id AS sceneId, ${scenes}.sceneType, 
        ${scenes}.keyFreq, ${scenes}.mouseButtonFreq, ${scenes}.swipeFreq, ${scenes}.avgSwipeSpeed,
        ${scenes}.killDeathRatio, ${scenes}.belowAbove50HpRatio, ${scenes}.hitRatio, ${scenes}.damageGivenTakenRatio, ${scenes}.questCompletionRatio,
        ${scenes}.sceneDuration, ${scenes}.kills, ${scenes}.deaths, ${scenes}.completedQuests,
        ${scenes}.generalExp, ${scenes}.diffExp, ${scenes}.otherExp, dateTime
        FROM ${trainingSets}
        LEFT JOIN ${trainingSetToGame}
        ON ${trainingSets}.id = ${trainingSetToGame}.trainingSetId
        LEFT JOIN ${games}
        ON ${trainingSetToGame}.gameId = ${games}.id
        LEFT JOIN ${gameToScene}
        ON ${games}.id = ${gameToScene}.gameId
        LEFT JOIN ${scenes}
        ON ${gameToScene}.sceneId = ${scenes}.id
        WHERE ${trainingSets}.id = 2 OR ${trainingSets}.id = 3
        ORDER BY ${games}.id, dateTime;
    `;         

    async function Transaction () {
        const tx = await db.transaction();
        try {
            // Step 1: ####################################################
            if (showComments) console.log("#################### STEP 1: Getting batch of scenes ####################"); 

            if (writeFileForRStudio) query = query2;
            else query = query1;  
            rows = await tx.query(query);
            //if (showResults) console.log("JOIN - scenes obtained: " + JSON.stringify(rows));
            if (rows.length > 0) {
                reply.success = true;
                reply.text = `Number of scenes successfully obtained: ${rows.length}`;

                let str = "";
                for (let i=0; i<rows.length; i++) {
                    str += JSON.stringify(rows[i]);
                    if (i<rows.length-1) str += "_";
                }
                reply.sceneDataBatchString = str;
                if (showResults) console.log(`Scenes found : ${rows.length}`);


                // Convert the query results to a JSON string
                // ------------------------------------------
                const data = JSON.stringify(rows);

                // Save the data to a file
                if (writeFileForRStudio) {
                    fs.writeFile('sceneData.json', data, (err) => {
                        if (err) throw err;
                        console.log('Data saved to data.json file');
                    });
                }
                // ------------------------------------------                
            }
            else {
                if (showResults) console.log(`Scenes obtained : 0`);
            }



            // Last: ####################################################            
            if (showComments) console.log("#################### LAST STEP, COMMITTING ####################");            
            await tx.commit();
            if (showComments) console.log('##### Commit done #####\n');
            return reply;  // Returning reply (to post-request by Unity game).
        }
        catch (err) {
            console.error(err);
            await tx.rollback();
            throw err;
        }
    };
    reply = await Transaction();
    return reply;
}


// Routes ==================================================================
// =========================================================================
app.post('/createNewTrainingSet_SetActive', async function (req, res) {
    let trainingSetName = req.body.trainingSetName;
    let gamesAllowed = req.body.gamesAllowed;
    let activateTheSet = req.body.activateTheSet;
    let reply = await CreateNewTrainingSet_SetActive(DB, trainingSetName, gamesAllowed, activateTheSet);
    res.send(reply);
})

app.post('/checkGameCount', async function (req, res) {
    let trainingSetName = req.body.trainingSetName;
    let givenPlayerId = req.body.givenPlayerId;
    let reply = await CheckGameCount(DB, trainingSetName, givenPlayerId);
    res.send(reply);
})

app.post('/getML_Parameters', async function (req, res) {
    let reply = await GetML_Parameters(DB);
    res.send(reply);
})

app.post('/newSceneRecord_UpdateSet', async function (req, res) {
    // Machine learning parameters.
    let givenSetID = req.body.givenSetID;
    let givenWeightBias_BLOB = req.body.givenWeightBias_BLOB;
    let givenQTableGeneralExp_BLOB = req.body.givenQTableGeneralExp_BLOB;
    let givenQTableDiffExp_BLOB = req.body.givenQTableDiffExp_BLOB;
    // Game.
    let givenGameID = req.body.givenGameID;
    let playerID = req.body.playerID;
    let isControlGroup = req.body.isControlGroup;
    let playerType = req.body.playerType;
    let playerSkill = req.body.playerSkill;
    let gameComplete = req.body.gameComplete;
    // Scene
    let sceneType = req.body.sceneType;
    let keyFreq = req.body.keyFreq;
    let mouseButtonFreq = req.body.mouseButtonFreq;
    let swipeFreq = req.body.swipeFreq;
    let avgSwipeSpeed = req.body.avgSwipeSpeed;
    // Scene    
    let killDeathRatio = req.body.killDeathRatio;
    let belowAbove50HpRatio = req.body.belowAbove50HpRatio;
    let hitRatio = req.body.hitRatio;
    let damageGivenTakenRatio = req.body.damageGivenTakenRatio;
    let questCompletionRatio = req.body.questCompletionRatio;
    // Scene
    let sceneDuration = req.body.sceneDuration;
    let kills = req.body.kills;
    let deaths = req.body.deaths;
    let completedQuests = req.body.completedQuests;
    // Scene
    let keyData = req.body.keyData;
    let mouseData = req.body.mouseData;
    let generalExp = req.body.generalExp;
    let diffExp = req.body.diffExp;
    let otherExp = req.body.otherExp;

    let reply = await NewSceneRecord_UpdateSet(DB,
        givenSetID, givenWeightBias_BLOB, givenQTableGeneralExp_BLOB, givenQTableDiffExp_BLOB,
        givenGameID, playerID, isControlGroup, playerType, playerSkill, gameComplete,
        sceneType, keyFreq, mouseButtonFreq, swipeFreq, avgSwipeSpeed,
        killDeathRatio, belowAbove50HpRatio, hitRatio, damageGivenTakenRatio, questCompletionRatio,
        sceneDuration, kills, deaths, completedQuests,
        keyData, mouseData, generalExp, diffExp, otherExp);
    res.send(reply);
})
app.post('/getSceneBatch', async function (req, res) {

    let reply = await GetSceneBatch(DB, false);
    res.send(reply);
})
// =========================================================================
// =========================================================================


// =========================================================================
// Starting node server
app.listen(localPort, ()=>{
    console.log(`UX-Game node-server listening on http://${localHost}:${localPort}`);
});
// =========================================================================