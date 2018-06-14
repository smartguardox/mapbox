const testCases = [];

testCases[0] = [
    new Point(50, 50),
    new Point(350, 70),
    new Point(400, 150),
    new Point(420, 200),
    new Point(230, 370),
    new Point(40, 290)
];

testCases[1] = [
    new Point(50, 50),
    new Point(700, 51),
    new Point(740, 151),
    new Point(730, 351),
    new Point(520, 71),
    new Point(401, 300),
    new Point(301, 300),
    new Point(175, 80),
    new Point(51, 301)
];

testCases[2] = [
    new Point(50, 50),
    new Point(700, 51),
    new Point(740, 451),
    new Point(350, 451),
    new Point(550, 251),
    new Point(175, 80),
    new Point(81, 301),
    new Point(281, 401),
    new Point(51, 401)
];

let drawn = [[-330,1263],[-319,1340],[-376,1390],[-442,1387],[-571,1390],[-689,1384],[-797,1280],[-813,1217],[-604,1288],[-602,1261],[-742,1214],[-731,1093],[-687,1093],[-681,1134],[-643,1153],[-656,1063],[-656,931],[-656,873],[-623,851],[-602,862],[-571,851],[-560,879],[-585,879],[-566,901],[-500,906],[-533,926],[-533,950],[-500,975],[-478,986],[-464,917],[-442,937],[-409,937],[-371,942],[-349,915],[-354,849],[-412,849],[-500,846],[-541,827],[-519,750],[-434,670],[-357,634],[-288,634],[-242,610],[-242,547],[-280,442],[-294,442],[-406,456],[-420,456],[-486,527],[-492,566],[-514,623],[-574,670],[-733,802],[-733,843],[-750,882],[-783,934],[-802,953],[-846,969],[-945,972],[-1024,972],[-1068,906],[-1096,840],[-1057,758],[-981,791],[-890,791],[-865,750],[-868,676],[-898,629],[-942,533],[-920,393],[-840,335],[-758,313],[-744,148],[-711,16],[-612,11],[-500,47],[-409,110],[-302,121],[-209,124],[-159,115],[-102,77],[-60,22],[-33,3],[0,0],[44,5],[157,41],[195,126],[170,157],[107,187],[107,244],[107,327],[110,420],[110,461],[110,525],[91,599],[110,648],[113,662],[135,687],[179,700],[214,706],[266,736],[297,750],[324,772],[332,805],[335,840],[313,876],[269,904],[214,928],[159,873],[159,818],[159,766],[157,750],[113,728],[41,733],[0,766],[-25,827],[-36,882],[-36,906],[-11,931],[91,956],[173,980],[236,1033],[236,1044],[233,1082],[220,1153],[184,1228],[151,1263],[63,1274],[0,1244],[-52,1217],[-110,1214],[-148,1233],[-173,1255],[-192,1288],[-195,1305],[-192,1337],[-151,1357],[-137,1324],[-93,1346],[-102,1392],[-121,1425],[-187,1425],[-239,1359],[-269,1318],[-288,1288]];

testCases[3] = [];
drawn.reverse();

//drawn = drawn.slice(09, 111);

/*
drawn = drawn.slice(09, 111);
drawn.splice(20, 20);
drawn.splice(28, 20);
drawn.splice(0, 19);
drawn.splice(10, 21);
drawn.splice(15, 6);
drawn.splice(4, 4);
drawn.splice(5, 2);
drawn.splice(3, 1);
drawn.splice(4, 1);
drawn.splice(8, 1);
*/

/*
drawn = drawn.slice(09, 111);
drawn.splice(20, 20);
drawn.splice(28, 20);
drawn.splice(29, 20);
drawn.splice(28, 5);
drawn.splice(5, 6);
drawn.splice(6, 3);
drawn.splice(7, 11);
drawn.splice(2, 3);
drawn.splice(3, 1);
drawn.splice(7, 3);
drawn[1][0] += 1;
drawn[1][1] += -160;
*/
//drawn.splice(28, 1);

/*
drawn = drawn.slice(09, 97);
*/

/*
drawn = drawn.slice(59, 97);
drawn.splice(2, 10);
drawn.splice(6, 10);
drawn.splice(7, 9);
drawn.splice(3, 1);
drawn.splice(1, 1);
*/

drawn = drawn.slice(09, 97);
//drawn = drawn.slice(54, 67);
/*
drawn.splice(1, 1);
drawn.splice(3, 1);
drawn.splice(4, 1);
drawn.splice(4, 1);
drawn.splice(5, 1);
drawn.splice(6, 1);
*/
for (const p of drawn) {
	testCases[3].push(new Point(p[0], -p[1]).mult(0.3).add(new Point(500, 600)));
}
